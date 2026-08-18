#!/usr/bin/env node
/**
 * Rebuild pipeline/universe.json from published constituent lists.
 *
 * The lists are not hardcoded and are never typed from memory: membership
 * changes constantly, and a stale hand-written list produces silent gaps
 * (missing recent additions) and silent errors (tickers that were renamed or
 * delisted). They are fetched, then validated against the data source we
 * actually use, because a name being in an index is no guarantee Yahoo serves
 * it under that ticker. Fiserv trades as FI, not FISV.
 *
 * Symbols that do not resolve are dropped and listed, so the exclusion is
 * visible rather than mysterious.
 *
 *   node pipeline/build-universe.js
 *   node pipeline/build-universe.js --indexes sp500,nasdaq,russell2000
 *   node pipeline/build-universe.js --indexes all --validate deep
 *   node pipeline/build-universe.js --dry-run
 *
 * ## Why there are tiers
 *
 * The S&P 500 costs about 29MB of committed raw and twenty-five minutes to
 * backfill. Adding Nasdaq and the Russell 2000 takes the universe past five
 * thousand names, which at the same treatment is roughly 350MB in git, nine
 * million price rows, and five hours of extraction against an upstream that
 * rate-limits by IP. The nightly job has a sixty-minute budget.
 *
 * So a symbol's index membership decides how much of it is fetched:
 *
 *   deep  every entity: prices, financials, dividends, profile. The scorer
 *         needs statements, so anything that should appear in the screener has
 *         to be here.
 *   wide  prices only, over a shorter window. Enough to chart it, search it and
 *         measure its return; not enough to grade it.
 *
 * Deep defaults to the S&P 500 and is set with --deep. Nothing stops
 * `--deep all`, and the numbers above are what it will cost.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as yahoo from '../lib/yahoo.js';
import { INDEXES, INDEX_NAMES } from './sources.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UNIVERSE_PATH = join(ROOT, 'pipeline', 'universe.json');
const RAW_DIR = join(ROOT, 'warehouse', 'raw');

const CONCURRENCY = 6;

/* --------------------------------------------------------------- arguments */

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
}

const dryRun = process.argv.includes('--dry-run');
const expand = (value) => (value === 'all' ? [...INDEX_NAMES] : value.split(',').map((s) => s.trim()).filter(Boolean));

const requested = expand(arg('indexes', 'sp500'));
const deepIndexes = expand(arg('deep', 'sp500'));
// Validating five thousand tickers is five thousand upstream calls against a
// service that rate-limits, and the extract already drops a symbol it cannot
// fetch. So the default validates what will be scored and trusts the rest.
const validateMode = arg('validate', 'deep');

const unknown = [...requested, ...deepIndexes].filter((name) => !INDEXES[name]);
if (unknown.length) {
  console.error(`Unknown index: ${unknown.join(', ')}. Known: ${INDEX_NAMES.join(', ')}`);
  process.exit(1);
}

/* ----------------------------------------------------------------- fetching */

/** A symbol counts as usable if Yahoo returns a priced bar for it. */
async function validate(symbols) {
  const queue = [...symbols];
  const ok = [];
  const failed = [];
  let done = 0;

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const symbol = queue.shift();
      if (!symbol) break;
      try {
        const chart = await yahoo.getChart(symbol, '1mo');
        if (chart.points.length) ok.push(symbol);
        else failed.push({ symbol, reason: 'no price points' });
      } catch (err) {
        failed.push({ symbol, reason: err.message.slice(0, 60) });
      }
      done++;
      if (done % 100 === 0) process.stdout.write(`  validated ${done}/${symbols.length}\n`);
    }
  });

  await Promise.all(workers);
  return { ok: ok.sort(), failed };
}

/**
 * Record who was in each index at this moment, append-only.
 *
 * Overwriting universe.json alone would bake survivorship bias into everything
 * downstream: the file holds *today's* members, so years of history for "the
 * S&P 500" would silently exclude every company that was dropped, and companies
 * get dropped disproportionately because they failed. Any backtest over that
 * gives flattering, wrong answers.
 *
 * Each run therefore appends a full membership observation per index.
 * dim_index_membership folds them into valid_from / valid_to intervals, so
 * membership at any past date is reconstructable.
 */
async function recordMembership(members, observedAt) {
  await mkdir(RAW_DIR, { recursive: true });
  const path = join(RAW_DIR, `membership__${observedAt.replace(/[:.]/g, '-')}.jsonl.gz`);

  const gzip = createGzip({ level: 9 });
  const file = createWriteStream(path);
  gzip.pipe(file);

  for (const [indexName, symbols] of Object.entries(members)) {
    for (const symbol of symbols) {
      gzip.write(
        JSON.stringify({
          symbol,
          index_name: indexName,
          observed_at: observedAt,
          source: INDEXES[indexName].label,
          _ingested_at: observedAt,
        }) + '\n',
      );
    }
  }

  // Wait on the file, not the gzip: ending compression does not mean the bytes
  // reached disk, and exiting early writes an empty member.
  await new Promise((resolve, reject) => {
    file.on('finish', resolve);
    file.on('error', reject);
    gzip.end();
  });
  return path;
}

/* --------------------------------------------------------------------- main */

async function main() {
  const byIndex = {};
  for (const name of requested) {
    process.stdout.write(`Fetching ${INDEXES[name].label}\n`);
    const { symbols, source } = await INDEXES[name].fetch();
    byIndex[name] = { symbols: symbols.sort(), source };
    console.log(`  ${symbols.length} symbols listed`);
  }

  // A symbol can sit in several at once, and the deepest membership wins.
  const membership = new Map();
  for (const [name, { symbols }] of Object.entries(byIndex)) {
    for (const symbol of symbols) {
      if (!membership.has(symbol)) membership.set(symbol, []);
      membership.get(symbol).push(name);
    }
  }

  const isDeep = (symbol) => membership.get(symbol).some((name) => deepIndexes.includes(name));
  const all = [...membership.keys()].sort();
  const deep = all.filter(isDeep);
  const wide = all.filter((symbol) => !isDeep(symbol));

  console.log(`\n  ${all.length} unique symbols: ${deep.length} deep, ${wide.length} wide`);

  const toValidate = validateMode === 'all' ? all : validateMode === 'deep' ? deep : [];
  let failed = [];
  let resolved = new Set(all);

  if (toValidate.length) {
    console.log(`\nValidating ${toValidate.length} symbols against Yahoo Finance`);
    const result = await validate(toValidate);
    failed = result.failed;
    const bad = new Set(failed.map((f) => f.symbol));
    resolved = new Set(all.filter((symbol) => !bad.has(symbol)));
    console.log(`\n  resolved: ${result.ok.length}`);
    console.log(`  dropped:  ${failed.length}`);
    for (const f of failed.slice(0, 40)) console.log(`    ${f.symbol.padEnd(8)} ${f.reason}`);
    if (failed.length > 40) console.log(`    ... and ${failed.length - 40} more`);
  } else {
    console.log('\n  --validate none: symbols are trusted, the extract drops what it cannot fetch');
  }

  const kept = all.filter((symbol) => resolved.has(symbol));
  const observedAt = new Date().toISOString();

  const universe = {
    description:
      `Constituents of ${requested.map((n) => INDEXES[n].label).join(', ')}, fetched from the sources below ` +
      'and validated against Yahoo Finance. Rebuild with: node pipeline/build-universe.js',
    generated_at: observedAt,
    indexes: Object.fromEntries(
      Object.entries(byIndex).map(([name, { symbols, source }]) => [
        name,
        { label: INDEXES[name].label, source, listed: symbols.length },
      ]),
    ),
    tiers: {
      deep: { indexes: deepIndexes, entities: 'prices, financials, dividends, profile' },
      wide: { indexes: requested.filter((n) => !deepIndexes.includes(n)), entities: 'prices only' },
    },
    resolved: kept.length,
    dropped: failed.map((f) => f.symbol),
    // A flat list, kept first and kept as strings, because the extract has
    // always read this and there is no reason to break it.
    symbols: kept,
    // Which index each symbol came from, and how much of it to fetch.
    members: Object.fromEntries(kept.map((symbol) => [symbol, membership.get(symbol)])),
    deep: kept.filter(isDeep),
  };

  if (dryRun) {
    console.log('\n--dry-run: universe.json and membership not written');
    console.log(`  would write ${kept.length} symbols (${universe.deep.length} deep)`);
    return;
  }

  await writeFile(UNIVERSE_PATH, `${JSON.stringify(universe, null, 2)}\n`);
  const membershipPath = await recordMembership(
    Object.fromEntries(Object.entries(byIndex).map(([name, { symbols }]) => [name, symbols.filter((s) => resolved.has(s))])),
    observedAt,
  );

  console.log(`\nWrote ${UNIVERSE_PATH}`);
  console.log(`Wrote ${membershipPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
