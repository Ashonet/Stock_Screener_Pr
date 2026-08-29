#!/usr/bin/env node
/**
 * Run the deep extract in batches rather than as one long process.
 *
 * `extract.js` opens one file per entity per run and closes it at the end, so a
 * run that dies partway leaves a truncated gzip behind and a state.json whose
 * watermarks claim data those files do not contain. That combination is worse
 * than losing the run: the next incremental extract trusts the watermark, skips
 * the range, and the gap never fills.
 *
 * A full deep pass over the universe now takes over an hour, which is long
 * enough that dying partway is the expected case rather than the unlucky one.
 * Batching bounds the damage to a single batch: each one is its own extract
 * process writing its own complete files, so an interruption costs a few
 * minutes of work and leaves everything before it intact and committable.
 *
 * Usage:
 *   node pipeline/extract-batched.js                # all deep symbols
 *   node pipeline/extract-batched.js --size 250     # smaller batches
 *   node pipeline/extract-batched.js --start 12     # resume from batch 12
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};

const BATCH_SIZE = Math.max(1, Number(flag('size', 300)));
const START_AT = Math.max(0, Number(flag('start', 0)));

const run = (symbols) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(ROOT, 'pipeline', 'extract.js'), '--tier', 'deep', '--symbols', symbols.join(',')],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let tail = '';
    const keep = (chunk) => {
      tail = (tail + chunk).slice(-2000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', (code) => resolve({ code, tail }));
  });

const universe = JSON.parse(await readFile(join(ROOT, 'pipeline', 'universe.json'), 'utf8'));
const deep = universe.deep ?? universe.symbols ?? [];

const batches = [];
for (let i = 0; i < deep.length; i += BATCH_SIZE) batches.push(deep.slice(i, i + BATCH_SIZE));

console.log(`${deep.length} deep symbols in ${batches.length} batches of ${BATCH_SIZE}`);
if (START_AT) console.log(`resuming at batch ${START_AT + 1}`);

const started = Date.now();
let failed = 0;

for (let i = START_AT; i < batches.length; i++) {
  const at = Date.now();
  const { code, tail } = await run(batches[i]);
  const took = Math.round((Date.now() - at) / 1000);
  const elapsed = Math.round((Date.now() - started) / 60_000);
  const done = i + 1 - START_AT;
  const left = Math.round(((Date.now() - started) / done) * (batches.length - i - 1) / 60_000);

  if (code === 0) {
    console.log(`batch ${i + 1}/${batches.length} ok in ${took}s | ${elapsed}m elapsed, ~${left}m left`);
  } else {
    failed++;
    // Keep going. One failed batch is a gap in coverage, not a reason to
    // abandon the ones after it, and the failure is named so it can be re-run.
    console.log(`batch ${i + 1}/${batches.length} FAILED (exit ${code}) after ${took}s`);
    console.log(tail.split('\n').slice(-4).join('\n'));
  }
}

console.log(`done: ${batches.length - START_AT - failed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
