#!/usr/bin/env node
/**
 * Rebuild pipeline/universe.json from a published S&P 500 constituent list.
 *
 * The constituent list is not hardcoded and is never typed from memory: index
 * membership changes constantly, and a stale hand-written list produces silent
 * gaps (missing recent additions) and silent errors (tickers that were renamed
 * or delisted). It is fetched, then every symbol is validated against the data
 * source we actually use, because a name being in the index is no guarantee
 * Yahoo serves it under that ticker — Fiserv trades as FI, not FISV.
 *
 * Symbols that do not resolve are dropped and listed, so the exclusion is
 * visible rather than mysterious.
 *
 *   node pipeline/build-universe.js
 *   node pipeline/build-universe.js --dry-run
 */

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as yahoo from '../lib/yahoo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UNIVERSE_PATH = join(ROOT, 'pipeline', 'universe.json');

const SOURCE_URL =
  'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

const CONCURRENCY = 6;
const dryRun = process.argv.includes('--dry-run');

/**
 * Yahoo writes share-class separators as a hyphen where the index uses a dot:
 * BRK.B is BRK-B, BF.B is BF-B.
 */
const toYahoo = (ticker) => ticker.trim().toUpperCase().replace(/\./g, '-');

/** Minimal CSV field split that respects quoted commas. */
function firstField(line) {
  if (line.startsWith('"')) return line.slice(1, line.indexOf('"', 1));
  return line.slice(0, line.indexOf(','));
}

async function fetchConstituents() {
  const res = await fetch(SOURCE_URL, { headers: { 'user-agent': 'stock-warehouse/1.0' } });
  if (!res.ok) throw new Error(`constituent source returned ${res.status}`);
  const text = await res.text();

  const rows = text.trim().split(/\r?\n/).slice(1);
  const symbols = new Set();
  for (const row of rows) {
    const raw = firstField(row);
    if (/^[A-Z][A-Z.\-]{0,9}$/i.test(raw)) symbols.add(toYahoo(raw));
  }
  return [...symbols].sort();
}

/** A symbol counts as usable if Yahoo returns a priced bar for it. */
async function validate(symbols) {
  const ok = [];
  const failed = [];
  let done = 0;

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (symbols.length) {
      const symbol = symbols.shift();
      if (!symbol) break;
      try {
        const chart = await yahoo.getChart(symbol, '1mo');
        if (chart.points.length) ok.push({ symbol, name: chart.name });
        else failed.push({ symbol, reason: 'no price points' });
      } catch (err) {
        failed.push({ symbol, reason: err.message.slice(0, 60) });
      }
      done++;
      if (done % 50 === 0) process.stdout.write(`  validated ${done}…\n`);
    }
  });

  await Promise.all(workers);
  return { ok: ok.sort((a, b) => a.symbol.localeCompare(b.symbol)), failed };
}

async function main() {
  console.log(`Fetching constituents from ${SOURCE_URL}`);
  const constituents = await fetchConstituents();
  console.log(`  ${constituents.length} symbols listed\n`);

  console.log('Validating each against Yahoo Finance…');
  const { ok, failed } = await validate([...constituents]);

  console.log(`\n  resolved: ${ok.length}`);
  console.log(`  dropped:  ${failed.length}`);
  for (const f of failed) console.log(`    ${f.symbol.padEnd(8)} ${f.reason}`);

  const universe = {
    description:
      'S&P 500 constituents, fetched from the source below and validated against Yahoo Finance. ' +
      'Rebuild with: node pipeline/build-universe.js',
    source: SOURCE_URL,
    generated_at: new Date().toISOString(),
    resolved: ok.length,
    dropped: failed.map((f) => f.symbol),
    symbols: ok.map((s) => s.symbol),
  };

  if (dryRun) {
    console.log('\n--dry-run: universe.json not written');
    return;
  }
  await writeFile(UNIVERSE_PATH, JSON.stringify(universe, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${UNIVERSE_PATH} with ${ok.length} symbols`);
}

main().catch((err) => {
  console.error('build-universe failed:', err);
  process.exit(1);
});
