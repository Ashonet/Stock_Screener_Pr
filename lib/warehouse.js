/**
 * Read-only query layer over the DuckDB warehouse.
 *
 * The warehouse is the pipeline's output, not the app's state: the app opens it
 * read-only and never writes. If the file is absent — a fresh clone that has
 * not run the pipeline yet — every accessor returns empty and the dashboard
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
    console.warn(`[warehouse] ${DB_PATH} not found — run the pipeline; serving live data only.`);
    return null;
  }

  try {
    const duckdb = require('duckdb');
    db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
    status = 'ready';
    console.log(`[warehouse] opened ${DB_PATH}`);
  } catch (err) {
    status = 'unavailable';
    console.warn(`[warehouse] could not open: ${err.message} — serving live data only.`);
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
 * DuckDB allows one writer, and a reader holding the file blocks it — so a
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
      ffo_per_share, currency, fiscal_year_end
    from mart_quality_score
    order by overall_score desc nulls last, symbol
  `);
  return plain(rows);
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

/** Sector rollup — the kind of question the live API could not answer at all. */
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
 * the mapping is spelled out rather than guessed at — an inferred conversion is
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
 * Everything the detail view needs for one security, from stored data.
 *
 * This is the fallback for when Yahoo's session-gated endpoints are
 * unavailable — which on a shared host is routine rather than exceptional. The
 * shape deliberately mirrors Yahoo's own module layout so buildProfile and
 * buildScore consume it unchanged: reshaping here rather than branching there
 * keeps one code path for scoring, so a stored security is graded by exactly the
 * same logic as a live one.
 */
export async function securityBundle(symbol, { period = 'annual' } = {}) {
  const [security] = await query('select * from dim_security where symbol = ?', [symbol]);
  if (!security) return null;

  const [prices, statements, dividends] = await Promise.all([
    query(
      `with recent as (
         select trade_date, open, high, low, close, volume,
                lag(close) over (order by trade_date) as prev_close,
                row_number() over (order by trade_date desc) as rn
         from fct_prices where symbol = ?
       ),
       window52 as (
         select max(high) as high_52w, min(low) as low_52w
         from fct_prices
         where symbol = ? and trade_date >= current_date - interval 1 year
       )
       select r.*, w.high_52w, w.low_52w
       from recent r cross join window52 w
       where r.rn = 1`,
      [symbol, symbol],
    ),
    query(
      `select * from fct_financials
       where symbol = ? and period_type = ?
       order by period_end`,
      [symbol, period],
    ),
    query('select pay_date, amount from fct_dividends where symbol = ? order by pay_date', [symbol]),
  ]);

  const sec = plain([security])[0];
  const price = plain(prices)[0] ?? {};

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
    },
    financialData: {
      currentPrice: price.close ?? sec.current_price,
      targetMeanPrice: sec.target_mean_price,
      recommendationKey: sec.recommendation_key,
      returnOnEquity: sec.return_on_equity_pct == null ? null : sec.return_on_equity_pct / 100,
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
    asOf: sec.ingested_at ?? null,
    priceAsOf: price.trade_date ?? null,
  };
}
