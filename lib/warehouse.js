/**
 * Read-only query layer over the DuckDB warehouse.
 *
 * The warehouse is the pipeline's output, not the app's state: the app opens it
 * read-only and never writes. If the file is absent (a fresh clone that has
 * not run the pipeline yet) every accessor returns empty and the dashboard
 * falls back to its live Yahoo path rather than failing to boot.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DB_PATH = process.env.WAREHOUSE_PATH || join(ROOT, 'warehouse', 'warehouse.duckdb');

// duckdb is a native module and CommonJS; require it lazily so a missing or
// unbuildable binary degrades to "no warehouse" instead of crashing the server.
const require = createRequire(import.meta.url);

let db = null;
let status = 'unopened';

function open() {
  if (db || status === 'unavailable') return db;

  if (!existsSync(DB_PATH)) {
    status = 'unavailable';
    console.warn(`[warehouse] ${DB_PATH} not found, run the pipeline; serving live data only.`);
    return null;
  }

  try {
    const duckdb = require('duckdb');
    db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
    status = 'ready';
    console.log(`[warehouse] opened ${DB_PATH}`);
  } catch (err) {
    status = 'unavailable';
    console.warn(`[warehouse] could not open: ${err.message}, serving live data only.`);
  }
  return db;
}

export const isReady = () => open() !== null;
export const warehouseStatus = () => ({ status, path: DB_PATH });

function query(sql, params = []) {
  const handle = open();
  if (!handle) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    handle.all(sql, ...params, (err, rows) => (err ? reject(err) : resolve(rows ?? [])));
  });
}

/**
 * Drop the handle so the next call re-opens.
 *
 * DuckDB allows one writer, and a reader holding the file blocks it, so a
 * `dbt build` while the server is running fails to acquire the lock. In
 * production that never overlaps (CI builds, then the container restarts), but
 * locally it does, and the fix is to let go rather than to hold on and serve
 * from a file that has been replaced underneath us.
 */
export function reopen() {
  try {
    db?.close();
  } catch {
    /* already gone */
  }
  db = null;
  status = 'unopened';
}

/**
 * DuckDB returns BIGINT as JS BigInt, which `JSON.stringify` refuses to
 * serialise. Coerce at the boundary so route handlers never have to think
 * about it.
 */
function plain(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'bigint') out[key] = Number(value);
      else if (value instanceof Date) out[key] = value.toISOString().slice(0, 10);
      else out[key] = value;
    }
    return out;
  });
}

/* ------------------------------------------------------------------ readers */

/** Every scored security, for the screener. */
export async function screener() {
  const rows = await query(`
    select
      symbol, name, sector, industry, scoring_basis, is_reit,
      overall_score, grade, coverage_pct,
      pillar_dividend, pillar_balance_sheet, pillar_growth,
      pillar_profitability, pillar_valuation,
      market_cap, trailing_pe, price_to_ffo, payout_pct, raise_streak,
      net_debt_to_ebitda, interest_coverage,
      revenue_cagr_pct, per_share_cagr_pct, dividend_cagr_pct,
      ffo_per_share, currency, fiscal_year_end,
      -- Which indexes the company currently sits in, so the screener can be
      -- filtered to one without a second query.
      (
        select list(m.index_name order by m.index_name)
        from dim_index_membership m
        where m.symbol = mart_quality_score.symbol and m.is_current
      ) as indexes
    from mart_quality_score
    order by overall_score desc nulls last, symbol
  `);
  return plain(rows).map((row) => ({ ...row, indexes: row.indexes ?? [] }));
}

/** Latest close and day change per symbol, straight from the price fact. */
export async function latestPrices(symbols = []) {
  if (!symbols.length) return [];
  const list = symbols.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
  const rows = await query(`
    with ranked as (
      select
        symbol, trade_date, close, volume,
        lag(close) over (partition by symbol order by trade_date) as prev_close,
        row_number() over (partition by symbol order by trade_date desc) as rn
      from fct_prices
      where symbol in (${list})
    )
    select symbol, trade_date, close, prev_close, volume
    from ranked
    where rn = 1
  `);
  return plain(rows);
}

/** Freshness and row counts, for the pipeline health panel. */
export async function health() {
  const handle = open();
  if (!handle) return { available: false };

  const [[counts], [freshness]] = await Promise.all([
    query(`
      select
        (select count(*) from fct_prices)          as price_rows,
        (select count(*) from fct_financials)      as financial_rows,
        (select count(*) from fct_dividends)       as dividend_rows,
        (select count(*) from dim_security)        as securities,
        (select count(*) from mart_quality_score)  as scored
    `),
    query(`
      select
        max(trade_date)                                    as latest_trade_date,
        date_diff('day', max(trade_date), current_date)    as days_stale,
        max(ingested_at)                                   as last_ingested_at
      from fct_prices
    `),
  ]);

  return {
    available: true,
    ...plain([counts])[0],
    ...plain([freshness])[0],
  };
}

/** Sector rollup, the kind of question the live API could not answer at all. */
export async function sectorSummary() {
  const rows = await query(`
    select
      coalesce(sector, 'Unclassified')      as sector,
      count(*)                              as securities,
      round(avg(overall_score), 1)          as avg_score,
      round(avg(payout_pct), 1)             as avg_payout_pct,
      round(avg(net_debt_to_ebitda), 2)     as avg_net_debt_to_ebitda,
      sum(case when is_reit then 1 else 0 end) as reits
    from mart_quality_score
    group by 1
    having count(*) > 0
    order by avg_score desc nulls last
  `);
  return plain(rows);
}

/* ------------------------------------------------- warehouse-backed profile */

/**
 * Yahoo's statement columns arrive in the warehouse lower-cased, because DuckDB
 * folds unquoted identifiers. The app and the scorer both speak camelCase, so
 * the mapping is spelled out rather than guessed at. An inferred conversion is
 * how `annualEBITDA` became `eBITDA` in the first place.
 */
const FINANCIAL_COLUMNS = {
  totalrevenue: 'totalRevenue',
  costofrevenue: 'costOfRevenue',
  grossprofit: 'grossProfit',
  researchanddevelopment: 'researchAndDevelopment',
  sellinggeneralandadministration: 'sellingGeneralAndAdministration',
  otheroperatingexpenses: 'otherOperatingExpenses',
  operatingexpense: 'operatingExpense',
  totalexpenses: 'totalExpenses',
  operatingincome: 'operatingIncome',
  othernonoperatingincomeexpenses: 'otherNonOperatingIncomeExpenses',
  interestincome: 'interestIncome',
  interestexpense: 'interestExpense',
  netinterestincome: 'netInterestIncome',
  pretaxincome: 'pretaxIncome',
  taxprovision: 'taxProvision',
  taxrateforcalcs: 'taxRateForCalcs',
  netincome: 'netIncome',
  dilutedeps: 'dilutedEPS',
  basiceps: 'basicEPS',
  dilutedaverageshares: 'dilutedAverageShares',
  reconcileddepreciation: 'reconciledDepreciation',
  depreciationandamortization: 'depreciationAndAmortization',
  ebitda: 'ebitda',
  ebit: 'ebit',
  operatingcashflow: 'operatingCashFlow',
  capitalexpenditure: 'capitalExpenditure',
  freecashflow: 'freeCashFlow',
  totaldebt: 'totalDebt',
  cashandcashequivalents: 'cashAndCashEquivalents',
  stockholdersequity: 'stockholdersEquity',
  totalassets: 'totalAssets',
  cashdividendspaid: 'cashDividendsPaid',
};

/** Is this symbol tracked by the pipeline? */
export async function isTracked(symbol) {
  const rows = await query('select 1 from dim_security where symbol = ? limit 1', [symbol]);
  return rows.length > 0;
}

/**
 * The current members of an index, as a set.
 *
 * Used to keep a view inside the universe it claims to cover. Membership is
 * read from the current spell rather than from a static list so a company that
 * left the index stops being offered the day the pipeline notices.
 */
export async function indexMembers(index = STUDY_INDEX) {
  const rows = await query(
    'select distinct symbol from dim_index_membership where index_name = ? and is_current',
    [index],
  );
  return new Set(plain(rows).map((row) => row.symbol));
}

/**
 * Everything the detail view needs for one security, from stored data.
 *
 * This is the fallback for when Yahoo's session-gated endpoints are
 * unavailable, which on a shared host is routine rather than exceptional. The
 * shape deliberately mirrors Yahoo's own module layout so buildProfile and
 * buildScore consume it unchanged: reshaping here rather than branching there
 * keeps one code path for scoring, so a stored security is graded by exactly the
 * same logic as a live one.
 */
export async function securityBundle(symbol, { period = 'annual' } = {}) {
  const [security] = await query('select * from dim_security where symbol = ?', [symbol]);
  if (!security) return null;

  const [prices, statements, dividends, score] = await Promise.all([
    query(
      `with recent as (
         select trade_date, open, high, low, close, volume,
                lag(close) over (order by trade_date) as prev_close,
                row_number() over (order by trade_date desc) as rn
         from fct_prices where symbol = ?
       ),
       window52 as (
         select max(high) as high_52w, min(low) as low_52w,
                min(close) filter (where rn52 = 1) as close_1y_ago
         from (
           select high, low, close,
                  row_number() over (order by trade_date) as rn52
           from fct_prices
           where symbol = ? and trade_date >= current_date - interval 1 year
         )
       ),
       -- Moving averages and typical volume, which Yahoo would otherwise supply.
       averages as (
         select
           avg(close) filter (where rn <= 50)  as ma_50,
           avg(close) filter (where rn <= 200) as ma_200,
           avg(volume) filter (where rn <= 90) as avg_volume_90
         from (
           select close, volume, row_number() over (order by trade_date desc) as rn
           from fct_prices where symbol = ?
         )
       )
       select r.*, w.high_52w, w.low_52w, w.close_1y_ago, a.ma_50, a.ma_200, a.avg_volume_90
       from recent r cross join window52 w cross join averages a
       where r.rn = 1`,
      [symbol, symbol, symbol],
    ),
    query(
      `select * from fct_financials
       where symbol = ? and period_type = ?
       order by period_end`,
      [symbol, period],
    ),
    query('select pay_date, amount from fct_dividends where symbol = ? order by pay_date', [symbol]),
    query('select * from mart_quality_score where symbol = ?', [symbol]),
  ]);

  const sec = plain([security])[0];
  const price = plain(prices)[0] ?? {};
  const scored = plain(score)[0] ?? {};

  // The statements are already here, so most of what Yahoo's summary modules
  // carry can be recomputed rather than left blank. Without this the fallback
  // rendered eight metrics against the live path's thirty-eight, which looks
  // broken rather than degraded.
  const rows = plain(statements);
  const latest = rows.at(-1) ?? {};
  const prior = rows.at(-2) ?? {};
  const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null);
  const growth = (now, before) =>
    Number.isFinite(now) && Number.isFinite(before) && before > 0 ? (now - before) / before : null;

  const marketCap = sec.market_cap;
  const netDebt =
    latest.totaldebt != null ? latest.totaldebt - (latest.cashandcashequivalents ?? 0) : null;
  const enterpriseValue = marketCap != null && netDebt != null ? marketCap + netDebt : null;

  // Reshaped into Yahoo's module layout. Fractions where Yahoo uses fractions:
  // buildProfile and buildScore both multiply dividendYield and returnOnEquity
  // by 100, so handing them percentages would double-count.
  const summary = {
    price: {
      symbol: sec.symbol,
      longName: sec.name,
      currency: sec.currency,
      exchangeName: sec.exchange,
      quoteType: sec.quote_type,
      marketCap: sec.market_cap,
      regularMarketPrice: price.close ?? sec.current_price,
      regularMarketPreviousClose: price.prev_close,
      regularMarketTime: price.trade_date ? Date.parse(price.trade_date) / 1000 : null,
    },
    summaryDetail: {
      marketCap: sec.market_cap,
      trailingPE: sec.trailing_pe,
      dividendYield: sec.dividend_yield_pct == null ? null : sec.dividend_yield_pct / 100,
      fiveYearAvgDividendYield: sec.five_year_avg_dividend_yield_pct,
      beta: sec.beta,
      open: price.open,
      dayLow: price.low,
      dayHigh: price.high,
      volume: price.volume,
      previousClose: price.prev_close,
      fiftyTwoWeekHigh: price.high_52w,
      fiftyTwoWeekLow: price.low_52w,
      averageVolume: price.avg_volume_90,
      fiftyDayAverage: price.ma_50,
      twoHundredDayAverage: price.ma_200,
      priceToSalesTrailing12Months: ratio(marketCap, latest.totalrevenue),
      dividendRate: scored.pays_dividend && sec.dividend_yield_pct != null && price.close != null
        ? (sec.dividend_yield_pct / 100) * price.close
        : null,
      // Earnings payout, which is what this row means elsewhere in the app. The
      // score's payout is measured against cash flow and is a different figure.
      payoutRatio: ratio(Math.abs(latest.cashdividendspaid ?? NaN), latest.netincome),
      forwardPE: sec.forward_pe ?? null,
      exDividendDate: sec.ex_dividend_epoch ?? null,
    },
    summaryProfile: {
      sector: sec.sector,
      industry: sec.industry,
      country: sec.country,
      website: sec.website,
      longBusinessSummary: sec.description,
      fullTimeEmployees: sec.employees,
    },
    defaultKeyStatistics: {
      sharesOutstanding: sec.shares_outstanding,
      beta: sec.beta,
      enterpriseValue,
      trailingPE: sec.trailing_pe,
      priceToSalesTrailing12Months: ratio(marketCap, latest.totalrevenue),
      priceToBook: ratio(marketCap, latest.stockholdersequity),
      pegRatio: sec.peg_ratio ?? null,
      shortPercentOfFloat: sec.short_percent_of_float ?? null,
      earningsQuarterlyGrowth: sec.quarterly_earnings_growth ?? null,
      bookValue: ratio(latest.stockholdersequity, latest.dilutedaverageshares),
      trailingEps: latest.dilutedeps,
      profitMargins: ratio(latest.netincome, latest.totalrevenue),
      '52WeekChange': growth(price.close, price.close_1y_ago),
    },
    financialData: {
      currentPrice: price.close ?? sec.current_price,
      targetMeanPrice: sec.target_mean_price,
      targetLowPrice: sec.target_low_price ?? null,
      targetHighPrice: sec.target_high_price ?? null,
      targetMedianPrice: sec.target_median_price ?? null,
      numberOfAnalystOpinions: sec.analyst_opinions ?? null,
      recommendationMean: sec.recommendation_mean ?? null,
      currentRatio: sec.current_ratio ?? null,
      recommendationKey: sec.recommendation_key,
      returnOnEquity: sec.return_on_equity_pct == null ? null : sec.return_on_equity_pct / 100,
      ebitda: latest.ebitda,
      totalRevenue: latest.totalrevenue,
      freeCashflow: latest.freecashflow,
      totalCash: latest.cashandcashequivalents,
      totalDebt: latest.totaldebt,
      grossMargins: ratio(latest.grossprofit, latest.totalrevenue),
      operatingMargins: ratio(latest.operatingincome, latest.totalrevenue),
      profitMargins: ratio(latest.netincome, latest.totalrevenue),
      returnOnAssets: ratio(latest.netincome, latest.totalassets),
      // Percentage points, as Yahoo reports it, profile.js does not rescale.
      debtToEquity: ratio(latest.totaldebt, latest.stockholdersequity) == null
        ? null
        : ratio(latest.totaldebt, latest.stockholdersequity) * 100,
      // Year over year from the two most recent reported periods, rather than
      // the multi-year CAGR the score uses.
      revenueGrowth: growth(latest.totalrevenue, prior.totalrevenue),
      earningsGrowth: growth(latest.netincome, prior.netincome),
    },
    calendarEvents: {},
    recommendationTrend: {},
  };

  const financials = plain(statements).map((row) => {
    const out = { date: row.period_end };
    for (const [warehouseName, appName] of Object.entries(FINANCIAL_COLUMNS)) {
      if (row[warehouseName] != null) out[appName] = row[warehouseName];
    }
    return out;
  });

  const dividendPayments = plain(dividends).map((d) => ({ t: Date.parse(d.pay_date), amount: d.amount }));

  return {
    summary,
    financials,
    dividendPayments,
    // Three different freshness questions, kept apart because they have three
    // different answers and the interface labels them separately.
    //
    //   asOf            when the profile and quote fields were last stored
    //   financialsAsOf  when the statements were last stored
    //   priceAsOf       the last day the market traded, which is not an
    //                   ingest time at all and never dates the other two
    asOf: sec.ingested_at ?? null,
    financialsAsOf: plain(statements).reduce(
      (latest, row) => (row.ingested_at && (!latest || row.ingested_at > latest) ? row.ingested_at : latest),
      null,
    ),
    priceAsOf: price.trade_date ?? null,
  };
}

/**
 * The index the market map and the grade study are drawn from.
 *
 * Both were built when the warehouse held five hundred companies and both
 * quietly stopped working when it held four and a half thousand. A treemap is
 * a fixed area divided among its members, so 4,374 tiles are a few pixels each
 * and the thing it exists to show, which company moved and by how much, is no
 * longer legible. The grade study has the subtler problem: equal-weighting
 * every graded company means the microcap tail dominates by count, so an
 * A-grade basket becomes a statement about small illiquid companies rather
 * than about the grade.
 *
 * Restricting both to the S&P 500 keeps them comparable to what they were and
 * to each other. It is a deliberate narrowing rather than a limit of the data:
 * the screener still covers the full universe, and this is a parameter so the
 * choice stays visible and changeable rather than buried in a where clause.
 */
export const STUDY_INDEX = 'sp500';

/**
 * Market map: every tracked company with the two numbers a treemap needs,
 * how big it is and how it moved.
 *
 * The day's move comes from the price fact rather than a live quote: 505 live
 * quotes is well past what the upstream tolerates in one page load, and the
 * warehouse already holds every close. It is therefore the move as of the last
 * completed session, which the view states rather than implying it is live.
 */
export async function marketMap({ index = STUDY_INDEX } = {}) {
  const rows = await query(`
    with members as (
      select distinct symbol
      from dim_index_membership
      where index_name = ? and is_current
    ),
    ranked as (
      select
        symbol, trade_date, close,
        lag(close) over (partition by symbol order by trade_date) as prev_close,
        row_number() over (partition by symbol order by trade_date desc) as rn
      from fct_prices
    ),
    latest as (
      select symbol, trade_date, close, prev_close from ranked where rn = 1
    )
    select
      d.symbol,
      d.name,
      coalesce(d.sector, 'Unclassified') as sector,
      d.industry,
      d.is_reit,
      d.market_cap,
      l.close,
      l.prev_close,
      l.trade_date,
      case when l.prev_close > 0
           then (l.close - l.prev_close) / l.prev_close * 100 end as change_pct,
      q.overall_score,
      q.grade,
      q.scoring_basis
    from dim_security d
    join members m using (symbol)
    join latest l using (symbol)
    left join mart_quality_score q using (symbol)
    where d.market_cap > 0
    order by d.market_cap desc
  `, [index]);
  return plain(rows);
}

/**
 * The dividend record for a set of symbols, oldest first.
 *
 * `fct_dividends.pay_date` carries Yahoo's dividend event date, which is the
 * **ex-dividend** date rather than the date cash settles. The column name is
 * inherited from the upstream field and kept for continuity with the warehouse;
 * it is renamed at this boundary so nothing downstream has to remember which
 * one it holds. Income attribution wants the ex-date anyway: that is the
 * boundary that decides who receives the payment.
 */
export async function dividendsFor(symbols) {
  const list = [...new Set(symbols)].filter(Boolean);
  if (!list.length) return new Map();

  const placeholders = list.map(() => '?').join(', ');
  const rows = await query(
    `select symbol, pay_date as ex_date, amount as per_share
     from fct_dividends
     where symbol in (${placeholders})
     order by symbol, pay_date`,
    list,
  );

  const out = new Map();
  for (const row of plain(rows)) {
    if (row.per_share == null || row.per_share <= 0) continue;
    if (!out.has(row.symbol)) out.set(row.symbol, []);
    out.get(row.symbol).push({ exDate: row.ex_date, perShare: row.per_share });
  }
  return out;
}

/**
 * Monthly closes, raw and dividend-adjusted, for the compare view.
 *
 * `adj_close` is adjusted for splits *and* dividends, so the pair is exactly
 * "total return" against "price only" with no reinvestment maths of our own.
 * Sampled to month ends because comparing multi-year shapes does not need daily
 * resolution, and 505 symbols of daily bars is a payload nobody reads.
 */
export async function monthlyHistory(symbols, { years = 10 } = {}) {
  const list = [...new Set(symbols)].filter(Boolean);
  if (!list.length) return new Map();

  const placeholders = list.map(() => '?').join(', ');
  const rows = await query(
    `with monthly as (
       select
         symbol, trade_date, close, adj_close,
         row_number() over (
           partition by symbol, date_trunc('month', trade_date)
           order by trade_date desc
         ) as rn
       from fct_prices
       where symbol in (${placeholders})
         and trade_date >= current_date - interval '${Number(years)} year'
     )
     select symbol, trade_date, close, adj_close
     from monthly
     where rn = 1
     order by symbol, trade_date`,
    list,
  );

  const out = new Map();
  for (const row of plain(rows)) {
    if (row.close == null || row.close <= 0) continue;
    if (!out.has(row.symbol)) out.set(row.symbol, []);
    out.get(row.symbol).push({
      t: Date.parse(`${row.trade_date}T00:00:00Z`),
      close: row.close,
      adjClose: row.adj_close ?? row.close,
    });
  }
  return out;
}

/**
 * The windows a stored chart can be drawn over, and how densely.
 *
 * Intraday is the honest omission. A trading day is one row in `fct_prices`, so
 * there is no stored equivalent of a 5-minute bar and '1d' is left null rather
 * than answered with a single dot. The longer ranges are thinned the way the
 * live feed thins them, so a stored chart carries the same number of points as
 * the one it stands in for.
 */
const CHART_WINDOWS = {
  '1d': null,
  '5d': { days: 7, sample: 'day', interval: '1d' },
  '1mo': { days: 31, sample: 'day', interval: '1d' },
  '6mo': { days: 183, sample: 'day', interval: '1d' },
  ytd: { ytd: true, sample: 'day', interval: '1d' },
  '1y': { days: 366, sample: 'day', interval: '1d' },
  '5y': { days: 1827, sample: 'week', interval: '1wk' },
  max: { all: true, sample: 'month', interval: '1mo' },
};

/** The window as a SQL predicate against whichever date column a table uses. */
function windowClause(spec, column) {
  if (spec.all) return '';
  if (spec.ytd) return `and ${column} >= date_trunc('year', current_date)`;
  return `and ${column} >= current_date - interval '${Number(spec.days)} day'`;
}

/**
 * Keep the last row of each week or month.
 *
 * Rows arrive in date order, so writing every row into a Map keyed by its
 * bucket leaves the last one of each. A week is identified by the Thursday it
 * contains, which is the ISO week without needing a calendar table.
 */
function lastPerBucket(rows, unit) {
  const buckets = new Map();
  for (const row of rows) {
    const day = new Date(`${row.trade_date}T00:00:00Z`);
    const key =
      unit === 'month'
        ? row.trade_date.slice(0, 7)
        : new Date(day.getTime() + (3 - ((day.getUTCDay() + 6) % 7)) * 86_400_000)
            .toISOString()
            .slice(0, 10);
    buckets.set(key, row);
  }
  return [...buckets.values()];
}

/**
 * A price chart drawn from stored daily bars, shaped like the live one.
 *
 * The live chart is the single call the detail view could not do without. Every
 * other panel on that page already falls back to the warehouse, so a
 * rate-limited upstream took out the whole ticker rather than one card — the
 * one failure mode the fallbacks exist to prevent. The warehouse holds daily
 * OHLCV for every tracked symbol, which covers every range the dashboard offers
 * bar the intraday two.
 *
 * Returns null when there is nothing honest to draw — an untracked symbol, or a
 * window holding fewer than two sessions — and the caller then reports the
 * upstream failure rather than a chart standing on one point.
 */
export async function chartHistory(symbol, rangeKey = '1y') {
  const spec = CHART_WINDOWS[rangeKey];
  if (!spec) return null;

  const [security, bars, latest, dividends] = await Promise.all([
    query('select * from dim_security where symbol = ?', [symbol]),
    query(
      `select trade_date, close, volume
       from fct_prices
       where symbol = ? ${windowClause(spec, 'trade_date')}
       order by trade_date`,
      [symbol],
    ),
    // The quote fields Yahoo folds into the chart's metadata. The 52-week
    // extremes come off a full year regardless of the range being drawn,
    // because the hero's range meter always means a year.
    query(
      `with recent as (
         select trade_date, close, volume, ingested_at,
                lag(close) over (order by trade_date) as prev_close,
                row_number() over (order by trade_date desc) as rn
         from fct_prices where symbol = ?
       ),
       window52 as (
         select max(high) as high_52w, min(low) as low_52w
         from fct_prices
         where symbol = ? and trade_date >= current_date - interval 1 year
       )
       select r.trade_date, r.close, r.volume, r.ingested_at, r.prev_close,
              w.high_52w, w.low_52w
       from recent r cross join window52 w
       where r.rn = 1`,
      [symbol, symbol],
    ),
    query(
      `select pay_date, amount from fct_dividends
       where symbol = ? ${windowClause(spec, 'pay_date')}
       order by pay_date`,
      [symbol],
    ),
  ]);

  const sec = plain(security)[0];
  if (!sec) return null;

  const rows = plain(bars).filter((row) => row.close != null && row.close > 0);
  const sampled = spec.sample === 'day' ? rows : lastPerBucket(rows, spec.sample);
  if (sampled.length < 2) return null;

  const tip = plain(latest)[0] ?? {};
  const asOf = tip.ingested_at ? new Date(tip.ingested_at).toISOString() : null;

  return {
    symbol: sec.symbol,
    name: sec.name ?? sec.symbol,
    currency: sec.currency ?? 'USD',
    exchange: sec.exchange ?? null,
    instrumentType: sec.quote_type ?? 'EQUITY',
    price: tip.close ?? null,
    previousClose: tip.prev_close ?? null,
    // Intraday extremes are a live-session quantity; a daily bar has no opinion
    // on them, and a blank reads better than the day's close twice.
    dayHigh: null,
    dayLow: null,
    fiftyTwoWeekHigh: tip.high_52w ?? null,
    fiftyTwoWeekLow: tip.low_52w ?? null,
    volume: tip.volume ?? null,
    marketTime: tip.trade_date ? Date.parse(`${tip.trade_date}T00:00:00Z`) : null,
    gmtOffset: 0,
    range: rangeKey,
    interval: spec.interval,
    points: sampled.map((row) => ({
      t: Date.parse(`${row.trade_date}T00:00:00Z`),
      c: row.close,
      v: row.volume ?? 0,
    })),
    dividends: plain(dividends)
      .filter((row) => row.amount > 0)
      .map((row) => ({ t: Date.parse(`${row.pay_date}T00:00:00Z`), amount: row.amount })),
    // Marks the payload as stored so the view can label it; the live chart has
    // no such field, which is what makes its absence mean "live".
    stored: true,
    storedAsOf: asOf,
  };
}

/**
 * Company names for a set of symbols.
 *
 * A name is the one piece of a comparison that does not need a live quote, and
 * routing it through the session-gated quotes endpoint meant a rate limit
 * turned every legend entry into its own ticker twice over ("O, O"). The
 * warehouse already holds the name for every tracked security.
 */
export async function namesFor(symbols) {
  const list = [...new Set(symbols)].filter(Boolean);
  if (!list.length) return new Map();

  const placeholders = list.map(() => '?').join(', ');
  const rows = await query(`select symbol, name from dim_security where symbol in (${placeholders})`, list);
  return new Map(plain(rows).filter((r) => r.name).map((r) => [r.symbol, r.name]));
}

/**
 * Total return for every symbol between a date and the latest close.
 *
 * `adj_close` on both ends, so this is total return with distributions
 * included. The start is the first close on or after the date, since a window
 * boundary rarely lands on a trading day.
 */
export async function returnsSince(startDate) {
  const rows = await query(
    `with bounds as (
       select
         symbol,
         min(trade_date) filter (where trade_date >= ?) as start_date,
         max(trade_date) as end_date
       from fct_prices
       group by symbol
     )
     select
       b.symbol,
       b.start_date,
       b.end_date,
       s.adj_close as start_price,
       e.adj_close as end_price
     from bounds b
     join fct_prices s on s.symbol = b.symbol and s.trade_date = b.start_date
     join fct_prices e on e.symbol = b.symbol and e.trade_date = b.end_date
     where b.start_date is not null
       and s.adj_close > 0
       and e.adj_close > 0`,
    [startDate],
  );

  return plain(rows).map((r) => ({
    symbol: r.symbol,
    startDate: r.start_date,
    endDate: r.end_date,
    totalReturn: (r.end_price / r.start_price - 1) * 100,
  }));
}

/**
 * Everything the scorer needs to grade every tracked company at every past
 * reporting date, in three queries rather than three per symbol.
 *
 * Loading it whole and grouping in memory rather than looping the database is
 * the difference between one round trip and fifteen hundred.
 */
export async function scoringInputs({ index = STUDY_INDEX } = {}) {
  const member = `
    symbol in (select symbol from dim_index_membership where index_name = ? and is_current)
  `;

  const [securities, financials, dividends] = await Promise.all([
    query(`select symbol, name, industry, is_reit from dim_security where ${member}`, [index]),
    query(
      `select * from fct_financials
       where period_type = 'annual' and ${member}
       order by symbol, period_end`,
      [index],
    ),
    query(
      `select symbol, pay_date, amount from fct_dividends where ${member} order by symbol, pay_date`,
      [index],
    ),
  ]);

  const byFinancials = new Map();
  for (const row of plain(financials)) {
    const mapped = { date: row.period_end };
    for (const [column, key] of Object.entries(FINANCIAL_COLUMNS)) {
      if (row[column] != null) mapped[key] = row[column];
    }
    if (!byFinancials.has(row.symbol)) byFinancials.set(row.symbol, []);
    byFinancials.get(row.symbol).push(mapped);
  }

  const byDividends = new Map();
  for (const row of plain(dividends)) {
    if (!byDividends.has(row.symbol)) byDividends.set(row.symbol, []);
    byDividends.get(row.symbol).push({ t: Date.parse(`${row.pay_date}T00:00:00Z`), amount: row.amount });
  }

  return {
    securities: plain(securities),
    financials: byFinancials,
    dividends: byDividends,
  };
}

/**
 * The reference facts a portfolio breakdown groups on.
 *
 * Sector, industry and the REIT flag come from the security dimension; the
 * grade comes from the scoring mart, so a holding outside the scored universe
 * still gets its sector and simply has no grade.
 */
export async function securityFacets(symbols) {
  const list = [...new Set(symbols)].filter(Boolean);
  if (!list.length) return new Map();

  const placeholders = list.map(() => '?').join(', ');
  const rows = await query(
    `select
       d.symbol,
       d.name,
       d.sector,
       d.industry,
       d.country,
       d.is_reit,
       d.dividend_yield_pct,
       d.five_year_avg_dividend_yield_pct,
       q.grade,
       q.overall_score,
       q.scoring_basis
     from dim_security d
     left join mart_quality_score q using (symbol)
     where d.symbol in (${placeholders})`,
    list,
  );

  return new Map(
    plain(rows).map((row) => [
      row.symbol,
      {
        name: row.name ?? null,
        sector: row.sector ?? null,
        industry: row.industry ?? null,
        country: row.country ?? null,
        isReit: Boolean(row.is_reit),
        grade: row.grade ?? null,
        score: row.overall_score ?? null,
        basis: row.scoring_basis ?? null,
        // Carried for the dip finder: a yield above its own history is the
        // income side of a price that has fallen.
        dividendYieldPct: row.dividend_yield_pct ?? null,
        fiveYearAvgDividendYieldPct: row.five_year_avg_dividend_yield_pct ?? null,
      },
    ]),
  );
}

/**
 * Latest close with the high and low of the window around it.
 *
 * One pass over the window rather than three: the extremes and the most recent
 * row come out of the same scan.
 */
export async function priceRange(symbols, { days = 365 } = {}) {
  const list = [...new Set(symbols)].filter(Boolean);
  if (!list.length) return new Map();

  const placeholders = list.map(() => '?').join(', ');
  const rows = await query(
    `with windowed as (
       select
         symbol,
         trade_date,
         close,
         max(close) over (partition by symbol) as high,
         min(close) over (partition by symbol) as low,
         min(trade_date) over (partition by symbol) as from_date,
         row_number() over (partition by symbol order by trade_date desc) as rn
       from fct_prices
       where symbol in (${placeholders})
         and trade_date >= current_date - interval '${Number(days)} day'
     )
     select symbol, close as price, high, low, from_date, trade_date as as_of
     from windowed
     where rn = 1`,
    list,
  );

  return new Map(plain(rows).map((row) => [row.symbol, row]));
}

/** How many companies each index currently holds, scored or not. */
export async function indexSizes() {
  const rows = await query(`
    select index_name, count(distinct symbol) as members
    from dim_index_membership
    where is_current
    group by index_name
  `);
  return new Map(plain(rows).map((row) => [row.index_name, row.members]));
}

/**
 * The inputs for reading a company's multiple against its past and its peers.
 *
 * This mirrors the `mart_quality_score` valuation CTEs rather than reading
 * their output, for the same reason `lib/score.js` mirrors that model rather
 * than querying it: the JavaScript path has to work against a warehouse whose
 * marts have not been rebuilt, and a detail page that goes blank until the next
 * dbt run is worse than one that recomputes.
 *
 * The peer pool is every company with a usable multiple, not just the ones in
 * this symbol's group. Filtering to a group is `versusPeers`' job, and it needs
 * the whole pool to fall back from industry to sector.
 */
export async function valuationInputs(symbol) {
  const [prices, earnings, self, peers] = await Promise.all([
    // Raw close, not adj_close: earnings per share are reported in the share
    // basis of their own year, and an adjusted price would halve the multiple
    // across any split.
    query(
      `with month_end as (
         select symbol, max(trade_date) as trade_date
         from fct_prices
         where symbol = ?
         group by symbol, date_trunc('month', trade_date)
       )
       select cast(p.trade_date as varchar) as date, p.close
       from fct_prices p
       join month_end m on m.symbol = p.symbol and m.trade_date = p.trade_date
       order by p.trade_date`,
      [symbol],
    ),
    query(
      `select
         cast(a.period_end as varchar) as date,
         case when d.is_reit then a.ffo / nullif(a.dilutedaverageshares, 0) else a.dilutedeps end as eps
       from fct_financials a
       join dim_security d on d.symbol = a.symbol
       where a.symbol = ? and a.period_type = 'annual'
       order by a.period_end`,
      [symbol],
    ),
    query('select symbol, industry, sector, is_reit from dim_security where symbol = ?', [symbol]),
    query(
      `with reportable as (
         select
           a.symbol,
           case when d.is_reit then a.ffo / nullif(a.dilutedaverageshares, 0) else a.dilutedeps end as eps,
           a.period_end + interval 90 day as known_from
         from fct_financials a
         join dim_security d on d.symbol = a.symbol
         where a.period_type = 'annual'
           -- A period with no reported figure is absent data, not a loss, so it
           -- must not become the row the asof join lands on: Clorox has a null
           -- FY2025 EPS, and leaving it in the candidate set drops the company
           -- from every peer group instead of falling back to FY2024. This is
           -- the mirror of the rule that a genuine negative must NOT be skipped.
           and case when d.is_reit then a.ffo / nullif(a.dilutedaverageshares, 0) else a.dilutedeps end is not null
       ),
       latest_price as (
         select symbol, close, trade_date
         from (
           select symbol, close, trade_date,
                  row_number() over (partition by symbol order by trade_date desc) as rn
           from fct_prices
         )
         where rn = 1
       ),
       current_eps as (
         select l.symbol, l.close, e.eps
         from latest_price l
         asof join reportable e on l.symbol = e.symbol and l.trade_date >= e.known_from
         where e.eps > 0
       )
       select
         c.symbol,
         c.close / c.eps as multiple,
         d.industry,
         d.sector,
         d.is_reit
       from current_eps c
       join dim_security d on d.symbol = c.symbol`,
    ),
  ]);

  return {
    prices: plain(prices),
    earnings: plain(earnings),
    self: plain(self)[0] ?? null,
    peers: plain(peers).map((row) => ({
      symbol: row.symbol,
      multiple: row.multiple,
      industry: row.industry,
      sector: row.sector,
      isReit: Boolean(row.is_reit),
    })),
  };
}
