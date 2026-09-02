#!/usr/bin/env node
/**
 * Extract: Yahoo Finance -> the immutable raw layer.
 *
 * Writes newline-delimited JSON into warehouse/raw/, one file per entity per
 * run. Nothing is ever rewritten or deleted: the raw layer is append-only and
 * committed, so every downstream table is reproducible from git alone, and a
 * transformation bug is fixed by re-running dbt rather than re-hitting the API.
 *
 * Extraction is incremental because the upstream is rate-limited. Prices are
 * fetched only from each symbol's high-water mark (with a deliberate overlap,
 * see BACKFILL_OVERLAP_DAYS), and the slow-moving entities are skipped entirely
 * until their staleness window expires. A nightly run therefore costs a few
 * hundred rows rather than a full re-download.
 *
 * This deliberately reuses lib/yahoo.js rather than reimplementing the client:
 * that module is hardened against six documented upstream quirks (see the
 * README), and a fresh port would have quietly reintroduced them.
 *
 * Usage:
 *   node pipeline/extract.js                 # incremental
 *   node pipeline/extract.js --full          # ignore watermarks, backfill
 *   node pipeline/extract.js --symbols O,UNP # a subset, for debugging
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as yahoo from '../lib/yahoo.js';
import { MARKET_INDEX_SYMBOLS } from '../lib/markets.js';
import { num } from '../lib/yahoo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = join(ROOT, 'warehouse', 'raw');
const STATE_PATH = join(ROOT, 'pipeline', 'state.json');
const UNIVERSE_PATH = join(ROOT, 'pipeline', 'universe.json');

/**
 * Price history to pull on a cold start.
 *
 * Six years covers the dashboard's ranges and keeps a cold start to about
 * twenty-five minutes. The grade study wants more: its ten and twenty year
 * windows cannot be computed from six years of prices at all, and report
 * themselves unavailable rather than quietly measuring a shorter period. Raise
 * it with BACKFILL_YEARS=20 and re-run `npm run extract:full` to fill them in,
 * at roughly three times the rows and the runtime.
 */
const BACKFILL_YEARS = Math.min(30, Math.max(1, Number(process.env.BACKFILL_YEARS) || 6));

/**
 * How far back the wide tier goes.
 *
 * Shorter on purpose. The deep tier is five hundred companies and the wide tier
 * is nearly five thousand, so the tail dominates every cost there is: at six
 * years each it is roughly 350MB of committed raw and five hours against an
 * upstream that rate-limits by IP, against a nightly budget of sixty minutes.
 * Two years is enough to chart a name, search it and measure a recent return,
 * which is all the wide tier claims to support.
 */
const WIDE_BACKFILL_YEARS = Math.min(30, Math.max(1, Number(process.env.WIDE_BACKFILL_YEARS) || 2));

/**
 * Re-fetch this much already-loaded history on every incremental run.
 *
 * Yahoo restates recent bars, a split or dividend adjusts prior closes, and
 * the most recent session is provisional until it settles. Overlapping and
 * merging on (symbol, date) means a restatement corrects itself on the next
 * run instead of being frozen in by the watermark.
 */
const BACKFILL_OVERLAP_DAYS = 7;

/** How long each slow-moving entity may go unrefreshed. */
const STALENESS_HOURS = { security: 24, financials: 24 * 7, dividends: 24 * 7 };

/** Politeness delay between symbols; the upstream limits by IP. */
const THROTTLE_MS = 260;

const DAY_MS = 86_400_000;
const nowISO = () => new Date().toISOString();
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

/* ------------------------------------------------------------------- state */

async function readJSON(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

const isStale = (iso, hours) => !iso || Date.now() - Date.parse(iso) > hours * 3_600_000;

/* --------------------------------------------------------------- raw writer */

/**
 * One gzipped file per entity per run. The run id is in the filename so a
 * partial or failed run is visible in the landing zone rather than silently
 * interleaved with a good one.
 *
 * Gzip because the landing zone is committed and this data compresses ~87%:
 * the S&P 500 at six years of daily bars is ~230MB of JSON and ~30MB gzipped,
 * and a nightly slice is ~20KB. DuckDB's read_json_auto decompresses .jsonl.gz
 * transparently, so nothing downstream changes.
 *
 * A stream per entity rather than buffering: a full backfill is ~750k rows and
 * holding them all in memory to compress once would be gratuitous.
 */
class RawWriter {
  constructor(runId, ingestedAt) {
    this.runId = runId;
    this.ingestedAt = ingestedAt;
    this.counts = {};
    this.streams = new Map();
  }

  #streamFor(entity) {
    let entry = this.streams.get(entity);
    if (!entry) {
      const path = join(RAW_DIR, `${entity}__${this.runId}.jsonl.gz`);
      const gzip = createGzip({ level: 9 });
      const file = createWriteStream(path);
      gzip.pipe(file);
      // Both halves are kept: ending the gzip stream only signals that
      // compression finished, and the process can still exit before the piped
      // file stream has flushed, which writes a valid but empty 10-byte gzip.
      // The close path waits on the file's 'finish' event instead.
      entry = { gzip, file };
      this.streams.set(entity, entry);
    }
    return entry;
  }

  async write(entity, rows) {
    if (!rows.length) return;
    const { gzip } = this.#streamFor(entity);
    const body = rows
      .map((row) => JSON.stringify({ ...row, _ingested_at: this.ingestedAt, _run_id: this.runId }))
      .join('\n');

    // Respect backpressure: a fast extract can outrun compression + disk.
    if (!gzip.write(body + '\n')) {
      await new Promise((resolve) => gzip.once('drain', resolve));
    }
    this.counts[entity] = (this.counts[entity] ?? 0) + rows.length;
  }

  /**
   * Must be awaited before the process exits, and must wait on the *file*
   * stream: ending the gzip alone leaves the compressed tail unwritten.
   */
  async close() {
    await Promise.all(
      [...this.streams.values()].map(
        ({ gzip, file }) =>
          new Promise((resolve, reject) => {
            file.on('finish', resolve);
            file.on('error', reject);
            gzip.end();
          }),
      ),
    );
  }
}

/* ---------------------------------------------------------------- extractors */

function securityRows(symbol, summary, chart) {
  const profile = summary?.summaryProfile ?? {};
  const price = summary?.price ?? {};
  const detail = summary?.summaryDetail ?? {};
  const stats = summary?.defaultKeyStatistics ?? {};
  const financial = summary?.financialData ?? {};
  // Yahoo signals "no value" with an empty object, not null: Salesforce comes
  // back with market_cap: {} and Amazon with dividend_yield: {}. Passing that
  // through poisons the column's inferred type and fails the cast downstream,
  // so everything numeric goes through num(), which returns null for it.
  const raw = num;

  return [
    {
      symbol,
      name: price.longName ?? price.shortName ?? chart?.name ?? symbol,
      currency: price.currency ?? chart?.currency ?? 'USD',
      exchange: price.exchangeName ?? chart?.exchange ?? null,
      quote_type: price.quoteType ?? chart?.instrumentType ?? null,
      sector: profile.sector ?? null,
      industry: profile.industry ?? null,
      country: profile.country ?? null,
      employees: raw(profile.fullTimeEmployees),
      website: profile.website ?? null,
      description: profile.longBusinessSummary ?? null,
      market_cap: raw(price.marketCap) ?? raw(detail.marketCap),
      shares_outstanding: raw(stats.sharesOutstanding),
      trailing_pe: raw(detail.trailingPE),
      dividend_yield: raw(detail.dividendYield),
      five_year_avg_dividend_yield: raw(detail.fiveYearAvgDividendYield),
      beta: raw(stats.beta) ?? raw(detail.beta),
      current_price: raw(financial.currentPrice) ?? raw(price.regularMarketPrice),
      target_mean_price: raw(financial.targetMeanPrice),
      // Captured because they cannot be derived from the statements, so the
      // warehouse-backed view would otherwise show the analyst band as dashes.
      target_low_price: raw(financial.targetLowPrice),
      target_high_price: raw(financial.targetHighPrice),
      target_median_price: raw(financial.targetMedianPrice),
      analyst_opinions: raw(financial.numberOfAnalystOpinions),
      recommendation_key: financial.recommendationKey ?? null,
      recommendation_mean: raw(financial.recommendationMean),
      return_on_equity: raw(financial.returnOnEquity),
      current_ratio: raw(financial.currentRatio),
      forward_pe: raw(detail.forwardPE),
      peg_ratio: raw(stats.pegRatio),
      ex_dividend_date: raw(detail.exDividendDate),
      short_percent_of_float: raw(stats.shortPercentOfFloat),
      quarterly_earnings_growth: raw(stats.earningsQuarterlyGrowth),
    },
  ];
}

/**
 * Financials land in long form. One row per (symbol, period, metric).
 *
 * Yahoo's statement coverage differs by industry: a railway reports no R&D, a
 * REIT reports no capex. A wide table would need a column per metric and a
 * migration whenever Yahoo adds or drops one; long form absorbs that, and the
 * marts pivot to whatever shape each consumer wants.
 */
function financialRows(symbol, periodType, rows) {
  const out = [];
  for (const row of rows) {
    for (const [metric, value] of Object.entries(row)) {
      if (metric === 'date' || value == null || !Number.isFinite(value)) continue;
      out.push({ symbol, period_type: periodType, period_end: row.date, metric, value });
    }
  }
  return out;
}

/**
 * Whether a re-fetched bar disagrees with the close we already stored for it.
 *
 * Returns the ratio when the scale has moved and null otherwise. The tolerance
 * is loose enough to ignore a revised close, which moves by fractions of a
 * percent, and tight enough to catch a split, which moves it by a factor. Both
 * arrive through the same overlap window and only one of them means the whole
 * history is now wrong.
 */
function splitRatio(bars, previous) {
  if (!previous?.date || !(previous.close > 0)) return null;
  const match = bars.find((bar) => dayKey(bar.t) === previous.date);
  if (!match || !(match.close > 0)) return null;

  const ratio = match.close / previous.close;
  // A 2% band around 1 covers ordinary restatement noise. Anything outside it
  // on a bar that has already settled is a change of scale.
  return Math.abs(ratio - 1) > 0.02 ? ratio : null;
}

/* ------------------------------------------------------------------- driver */

async function extractSymbol(symbol, state, writer, { full, deep = true }) {
  const priceWatermark = state.prices?.[symbol] ?? null;
  const coldStart = full || !priceWatermark;
  const backfillYears = deep ? BACKFILL_YEARS : WIDE_BACKFILL_YEARS;
  const since = coldStart
    ? Date.now() - backfillYears * 365.25 * DAY_MS
    : Date.parse(priceWatermark) - BACKFILL_OVERLAP_DAYS * DAY_MS;

  const result = { symbol, prices: 0, financials: 0, dividends: 0, security: 0, errors: [], resplit: false };

  // Prices: the only entity fetched on every run.
  try {
    let bars = await yahoo.getDailyBars(symbol, since);

    /*
     * A split rewrites the whole history, not the overlap.
     *
     * The overlap window exists so a revised close lands and corrects in place,
     * and for that a week is plenty. A share split is different in kind: the
     * upstream restates *every* prior bar at once, and an incremental run that
     * only ever re-reads the last week leaves the older bars on the old scale
     * for good. Monster Beverage split two for one and the stored series kept a
     * permanent 50% cliff, which halved every return measured across it.
     *
     * So the overlap is used for what it is good at, detecting that something
     * changed, and the response is escalated to match. If a bar we already
     * hold comes back on a different scale, the symbol's whole history is
     * re-fetched rather than patched.
     */
    if (!coldStart && bars.length) {
      const ratio = splitRatio(bars, state.closes?.[symbol]);
      if (ratio) {
        console.log(`  ${symbol}: prices restated by ${ratio.toFixed(4)}x, re-fetching the full history`);
        bars = await yahoo.getDailyBars(symbol, Date.now() - backfillYears * 365.25 * DAY_MS);
        result.resplit = true;
      }
    }

    if (bars.length) {
      // Remember one recent close per symbol, which is all the detector above
      // needs to notice the scale moving under it on the next run.
      const latest = bars.at(-1);
      state.closes = state.closes ?? {};
      state.closes[symbol] = { date: dayKey(latest.t), close: latest.close };
    }

    if (bars.length) {
      await writer.write(
        'price',
        bars.map((bar) => ({
          symbol,
          trade_date: dayKey(bar.t),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          adj_close: bar.adjClose,
          volume: bar.volume,
        })),
      );
      result.prices = bars.length;

      // Split events land in their own entity. The warehouse needs them to
      // repair an adjusted close the upstream did not adjust.
      if (bars.splits?.length) {
        await writer.write(
          'split',
          bars.splits.map((split) => ({
            symbol,
            split_date: dayKey(split.t),
            numerator: split.numerator,
            denominator: split.denominator,
          })),
        );
        result.splits = bars.splits.length;
      }
      state.prices = state.prices ?? {};
      state.prices[symbol] = dayKey(bars.at(-1).t);
    }
  } catch (err) {
    result.errors.push(`prices: ${err.message}`);
  }

  /*
   * Everything below this line is the deep tier only.
   *
   * The scorer needs statements, so a company without them cannot be graded and
   * does not appear in the screener. Fetching them for five thousand names
   * would triple the run time and the stored bytes to populate a table nothing
   * reads. A wide-tier symbol is charted, searched and measured; it is not
   * scored, and the universe file says which is which.
   */
  if (!deep) {
    /*
     * A wide symbol still needs its row in the security dimension.
     *
     * fct_prices.symbol carries a relationships test against dim_security, so
     * prices arriving for something with no profile do not degrade gracefully:
     * they fail the build. Nothing had ever hit it because every symbol in the
     * universe was deep, which left the wide tier looking supported while being
     * quietly unbuildable.
     *
     * The chart's own metadata carries the name, currency, exchange and
     * instrument type, and securityRows already falls back to it, so this needs
     * no session and no second endpoint. Everything a company would supply from
     * its profile stays null, which for an index is simply the truth: it has no
     * sector, no employees and no market cap.
     */
    if (full || isStale(state.security?.[symbol], STALENESS_HOURS.security)) {
      try {
        const chart = await yahoo.getChart(symbol, '1mo');
        await writer.write('security', securityRows(symbol, null, chart));
        result.security = 1;
        state.security = state.security ?? {};
        state.security[symbol] = nowISO();
      } catch (err) {
        result.errors.push(`security: ${err.message}`);
      }
    }
    return result;
  }

  // Company profile and valuation snapshot.
  if (full || isStale(state.security?.[symbol], STALENESS_HOURS.security)) {
    try {
      const [summary, chart] = await Promise.all([
        yahoo.getSummary(symbol),
        yahoo.getChart(symbol, '1mo').catch(() => null),
      ]);
      await writer.write('security', securityRows(symbol, summary, chart));
      result.security = 1;
      state.security = state.security ?? {};
      state.security[symbol] = nowISO();
    } catch (err) {
      result.errors.push(`security: ${err.message}`);
    }
  }

  // Statements: annual and quarterly, refreshed weekly.
  if (full || isStale(state.financials?.[symbol], STALENESS_HOURS.financials)) {
    try {
      const [annual, quarterly] = await Promise.all([
        yahoo.getFinancials(symbol, 'annual'),
        yahoo.getFinancials(symbol, 'quarterly'),
      ]);
      const rows = [...financialRows(symbol, 'annual', annual), ...financialRows(symbol, 'quarterly', quarterly)];
      await writer.write('financial', rows);
      result.financials = rows.length;
      state.financials = state.financials ?? {};
      state.financials[symbol] = nowISO();
    } catch (err) {
      result.errors.push(`financials: ${err.message}`);
    }
  }

  // Dividends: the full record, refreshed weekly.
  if (full || isStale(state.dividends?.[symbol], STALENESS_HOURS.dividends)) {
    try {
      const history = await yahoo.getLongHistory(symbol);
      await writer.write(
        'dividend',
        history.dividends.map((d) => ({ symbol, pay_date: dayKey(d.t), amount: d.amount })),
      );
      result.dividends = history.dividends.length;
      state.dividends = state.dividends ?? {};
      state.dividends[symbol] = nowISO();
    } catch (err) {
      result.errors.push(`dividends: ${err.message}`);
    }
  }

  return result;
}

async function main() {
  const full = hasFlag('--full');
  const only = flagValue('--symbols');

  const universe = await readJSON(UNIVERSE_PATH, { symbols: [] });
  const tierFlag = flagValue('--tier');
  // A universe built before tiers existed has no `deep` list, and every symbol
  // in it was fetched in full. Treating that as all-deep keeps an old file
  // behaving exactly as it did.
  const deepSet = new Set((universe.deep ?? universe.symbols ?? []).map((s) => s.toUpperCase()));

  /*
   * The market strip's indices, always, and always wide.
   *
   * Deliberately not read from universe.json: that file is regenerated from
   * published constituent lists, and an index is not a constituent of anything,
   * so anything added to it by hand is lost on the next rebuild.
   */
  let symbols = only
    ? only.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [...new Set([...universe.symbols.map((s) => s.toUpperCase()), ...MARKET_INDEX_SYMBOLS])];

  if (tierFlag === 'deep') symbols = symbols.filter((s) => deepSet.has(s));
  else if (tierFlag === 'wide') symbols = symbols.filter((s) => !deepSet.has(s));

  if (!symbols.length) {
    console.error('No symbols to extract.');
    process.exit(1);
  }

  await mkdir(RAW_DIR, { recursive: true });
  // Always load the existing watermarks, even for --full. Starting from {} and
  // then writing the file back would erase the watermarks of every symbol not
  // in this run: `--full --symbols JNJ` would silently reset the other 502 and
  // trigger a complete re-download on the next incremental pass. The per-entity
  // checks below already ignore watermarks when `full` is set, so a full run
  // still refetches everything it touches.
  const state = await readJSON(STATE_PATH, {});

  const ingestedAt = nowISO();
  const runId = ingestedAt.replace(/[:.]/g, '-');
  const writer = new RawWriter(runId, ingestedAt);

  // An explicit --symbols run is all deep, so the count has to say so too.
  const deepCount = only ? symbols.length : symbols.filter((s) => deepSet.has(s)).length;
  console.log(
    `run ${runId} · ${symbols.length} symbols ` +
      `(${deepCount} deep, ${symbols.length - deepCount} wide) · ${full ? 'full backfill' : 'incremental'}`,
  );

  const failures = [];
  for (const [index, symbol] of symbols.entries()) {
    // An explicit --symbols run is treated as deep, since asking for one name
    // by hand means wanting all of it.
    const deep = only ? true : deepSet.has(symbol);
    const result = await extractSymbol(symbol, state, writer, { full, deep });
    const parts = [
      result.prices ? `${result.prices}p` : null,
      result.financials ? `${result.financials}f` : null,
      result.dividends ? `${result.dividends}d` : null,
      result.security ? 'meta' : null,
    ].filter(Boolean);
    console.log(
      `  [${String(index + 1).padStart(3)}/${symbols.length}] ${symbol.padEnd(6)} ${parts.join(' ') || 'up to date'}` +
        (result.errors.length ? `  !! ${result.errors.join('; ')}` : ''),
    );
    if (result.errors.length) failures.push({ symbol, errors: result.errors });
    await sleep(THROTTLE_MS);
  }

  // Flush and close the gzip streams FIRST. A half-written member is
  // unreadable, and advancing the watermark past a slice that never landed
  // would lose it permanently: the next run would start after data that was
  // never actually written.
  await writer.close();

  // The watermark file is written only after a clean pass over the symbol list,
  // so a crash mid-run replays that slice next time instead of skipping it.
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');

  const summary = Object.entries(writer.counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing new';
  console.log(`\nwrote ${summary}`);
  if (failures.length) {
    console.log(`${failures.length} symbol(s) had errors:`);
    for (const f of failures) console.log(`  ${f.symbol}: ${f.errors.join('; ')}`);
  }

  // A single bad ticker should not fail the pipeline; a broadly broken upstream
  // should. Anything past a third of the universe means something systemic.
  if (failures.length > symbols.length / 3) {
    console.error('\nToo many extraction failures, failing the run.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('extract failed:', err);
  process.exit(1);
});
