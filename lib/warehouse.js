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
