/**
 * Tests for the dip finder.
 *
 * The trap here is the yield ratio. Price and yield move opposite ways, so a
 * yield above its own average is a real signal that a payer has fallen, and it
 * is complete noise on a token dividend: NVIDIA once read 8.8 times its own
 * average purely because both numbers round to nothing. The same mistake in a
 * screen would rank a company that has barely moved at the top of a list of
 * bargains.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { findDips } from '../lib/dips.js';

const holding = (symbol, over = {}) => ({ symbol, shares: 10, cost: 100, ...over });
const range = (price, high, low, asOf = '2026-08-25') => ({ price, high, low, asOf });

describe('findDips', () => {
  test('reports how far under the high, and where in the range', () => {
    const result = findDips(
      [holding('VICI')],
      new Map([['VICI', range(25.96, 33.78, 25.93)]]),
      new Map([['VICI', { name: 'VICI Properties', grade: 'A+', score: 89 }]]),
    );
    const row = result.rows[0];

    assert.ok(Math.abs(row.offHigh + 23.15) < 0.05, `got ${row.offHigh}`);
    assert.ok(row.rangePosition < 1, 'sitting on its low');
    assert.equal(row.grade, 'A+', 'quality travels with the row');
  });

  test('deepest fall first', () => {
    const result = findDips(
      [holding('FLAT'), holding('DEEP'), holding('MILD')],
      new Map([
        ['FLAT', range(100, 100, 60)],
        ['DEEP', range(50, 100, 40)],
        ['MILD', range(90, 100, 70)],
      ]),
      new Map(),
    );

    assert.deepEqual(
      result.rows.map((r) => r.symbol),
      ['DEEP', 'MILD', 'FLAT'],
    );
  });

  test('a yield above its own average is reported for a real payer', () => {
    const result = findDips(
      [holding('VICI')],
      new Map([['VICI', range(25.96, 33.78, 25.93)]]),
      new Map([['VICI', { yieldPct: 6.83, avgYieldPct: 5.15 }]]),
    );

    assert.ok(Math.abs(result.rows[0].yieldVsAverage - 1.326) < 0.01);
  });

  test('a token dividend yields no ratio at all', () => {
    // The NVIDIA case. A 0.02% yield against a 0.0023% average reads 8.8x and
    // means nothing: both numbers round to nothing.
    const result = findDips(
      [holding('NVDA')],
      new Map([['NVDA', range(180, 200, 90)]]),
      new Map([['NVDA', { yieldPct: 0.02, avgYieldPct: 0.0023 }]]),
    );

    assert.equal(result.rows[0].yieldVsAverage, null);
    assert.equal(result.rows[0].yieldPct, 0.02, 'the yield itself is still reported');
  });

  test('the cost comparison is separate from the market one', () => {
    // A holding can be well off its high and still up on what it cost. Those
    // are different facts and conflating them is how a screen lies to you.
    const result = findDips(
      [holding('O', { cost: 45 })],
      new Map([['O', range(62.4, 67.56, 55.93)]]),
      new Map(),
    );
    const row = result.rows[0];

    assert.ok(row.offHigh < 0, 'below its high');
    assert.ok(row.vsCost > 0, 'and above its cost');
    assert.ok(Math.abs(row.vsCost - 38.67) < 0.05);
  });

  test('no cost basis means no cost comparison, not a zero', () => {
    const result = findDips([holding('O', { cost: null })], new Map([['O', range(62, 67, 55)]]), new Map());
    assert.equal(result.rows[0].vsCost, null);
  });

  test('counts how many are meaningfully off, not merely off', () => {
    const result = findDips(
      [holding('A'), holding('B'), holding('C')],
      new Map([
        ['A', range(99, 100, 50)],
        ['B', range(89, 100, 50)],
        ['C', range(60, 100, 50)],
      ]),
      new Map(),
    );

    assert.equal(result.dipping, 2, 'B and C are 10% or more off');
  });

  test('a symbol with no price history is named, not ranked', () => {
    const result = findDips([holding('GONE')], new Map(), new Map());

    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.excluded, [{ symbol: 'GONE', reason: 'no price history' }]);
  });

  test('a band with no width yields no position rather than dividing by zero', () => {
    // A symbol listed inside the window has barely any range to sit in.
    const result = findDips([holding('NEW')], new Map([['NEW', range(50, 50, 50)]]), new Map());

    assert.equal(result.rows[0].rangePosition, null);
    assert.equal(result.rows[0].offHigh, 0);
  });

  test('an empty wallet finds nothing rather than throwing', () => {
    const result = findDips();
    assert.deepEqual(result.rows, []);
    assert.equal(result.dipping, 0);
  });
});
