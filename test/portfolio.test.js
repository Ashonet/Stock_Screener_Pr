/**
 * Tests for the wallet maths.
 *
 * These target the cases that actually went wrong while building this, not a
 * uniform sweep of the API: series alignment across holdings with different
 * histories, the start-date rule that stops a late-listing holding reading as a
 * gain, and partial cost-basis coverage.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseHoldings, buildValueSeries, priceHoldings } from '../lib/portfolio.js';

const DAY = 86_400_000;
const bars = (start, closes) => ({ points: closes.map((c, i) => ({ t: start + i * DAY, c })) });

describe('parseHoldings', () => {
  test('parses symbol, shares and optional cost', () => {
    assert.deepEqual(parseHoldings('AAPL:10:150'), [{ symbol: 'AAPL', shares: 10, cost: 150 }]);
    assert.deepEqual(parseHoldings('AAPL:10'), [{ symbol: 'AAPL', shares: 10, cost: null }]);
  });

  test('uppercases and de-duplicates', () => {
    assert.deepEqual(
      parseHoldings('aapl:1,AAPL:2').map((h) => h.symbol),
      ['AAPL'],
    );
  });

  test('rejects junk rather than coercing it', () => {
    // Zero and negative share counts are not holdings; a bad ticker is not a
    // ticker. Silently coercing either would put nonsense in the totals.
    assert.deepEqual(parseHoldings('AAPL:0'), []);
    assert.deepEqual(parseHoldings('AAPL:-5'), []);
    assert.deepEqual(parseHoldings('AAPL:abc'), []);
    assert.deepEqual(parseHoldings('not a ticker:1'), []);
    assert.deepEqual(parseHoldings(''), []);
    assert.deepEqual(parseHoldings(null), []);
  });

  test('a negative cost basis is dropped, the holding is kept', () => {
    assert.deepEqual(parseHoldings('AAPL:10:-3'), [{ symbol: 'AAPL', shares: 10, cost: null }]);
  });
});

describe('buildValueSeries', () => {
  const t0 = Date.UTC(2026, 0, 1);

  test('sums holdings on matching dates', () => {
    const series = buildValueSeries([
      { holding: { symbol: 'A', shares: 2 }, chart: bars(t0, [10, 11]) },
      { holding: { symbol: 'B', shares: 3 }, chart: bars(t0, [100, 100]) },
    ]);
    assert.deepEqual(
      series.points.map((p) => p.c),
      [2 * 10 + 3 * 100, 2 * 11 + 3 * 100],
    );
  });

  test('starts only where every holding has a price', () => {
    // B lists a day late. Starting earlier would value the wallet at A alone and
    // then jump when B appears, which reads as a gain that never happened.
    const series = buildValueSeries([
      { holding: { symbol: 'A', shares: 1 }, chart: bars(t0, [10, 10, 10]) },
      { holding: { symbol: 'B', shares: 1 }, chart: bars(t0 + DAY, [5, 5]) },
    ]);
    assert.equal(series.points.length, 2);
    assert.equal(series.startedAt, t0 + DAY);
    assert.ok(series.points.every((p) => p.c === 15));
  });

  test('carries the last known close forward across a missing session', () => {
    // B has no bar on day 2 (a holiday on its exchange). Its value should hold,
    // not vanish from the total.
    const series = buildValueSeries([
      { holding: { symbol: 'A', shares: 1 }, chart: bars(t0, [10, 20, 30]) },
      { holding: { symbol: 'B', shares: 1 }, chart: { points: [{ t: t0, c: 5 }, { t: t0 + 2 * DAY, c: 5 }] } },
    ]);
    assert.deepEqual(
      series.points.map((p) => p.c),
      [15, 25, 35],
    );
  });

  test('reports unpriced holdings instead of dropping them silently', () => {
    const series = buildValueSeries([
      { holding: { symbol: 'A', shares: 1 }, chart: bars(t0, [10]) },
      { holding: { symbol: 'BAD', shares: 1 }, chart: null },
    ]);
    assert.deepEqual(series.coverage, [
      { symbol: 'A', priced: true },
      { symbol: 'BAD', priced: false },
    ]);
  });

  test('no priced holdings yields an empty series, not a crash', () => {
    const series = buildValueSeries([{ holding: { symbol: 'BAD', shares: 1 }, chart: null }]);
    assert.deepEqual(series.points, []);
    assert.equal(series.startedAt, null);
  });
});

describe('priceHoldings', () => {
  const quotes = [
    { symbol: 'A', price: 100, previousClose: 90, change: 10, currency: 'USD', name: 'A Inc' },
    { symbol: 'B', price: 50, previousClose: 50, change: 0, currency: 'USD', name: 'B Inc' },
  ];

  test('values positions and computes gain against cost', () => {
    const { rows, totals } = priceHoldings([{ symbol: 'A', shares: 2, cost: 80 }], quotes);
    assert.equal(rows[0].value, 200);
    assert.equal(rows[0].costTotal, 160);
    assert.equal(rows[0].gain, 40);
    assert.equal(totals.value, 200);
  });

  test('weights sum to 100%', () => {
    const { rows } = priceHoldings(
      [
        { symbol: 'A', shares: 1, cost: null },
        { symbol: 'B', shares: 2, cost: null },
      ],
      quotes,
    );
    const total = rows.reduce((sum, r) => sum + r.weight, 0);
    assert.ok(Math.abs(total - 100) < 1e-9, `weights summed to ${total}`);
  });

  test('gain covers only the holdings that have a cost basis', () => {
    // Reporting a gain across positions whose cost is unknown would understate
    // it and look authoritative doing so. costCoverage says how much is covered.
    const { totals } = priceHoldings(
      [
        { symbol: 'A', shares: 1, cost: 90 },
        { symbol: 'B', shares: 1, cost: null },
      ],
      quotes,
    );
    assert.equal(totals.costTotal, 90);
    assert.equal(totals.gain, 10);
    assert.equal(totals.costCoverage, 0.5);
  });

  test('an unpriced holding nulls its row without poisoning the totals', () => {
    const { rows, totals } = priceHoldings(
      [
        { symbol: 'A', shares: 1, cost: 50 },
        { symbol: 'GONE', shares: 5, cost: 10 },
      ],
      quotes,
    );
    const gone = rows.find((r) => r.symbol === 'GONE');
    assert.equal(gone.value, null);
    assert.equal(totals.value, 100);
  });

  test('day change percentage is measured against the previous close', () => {
    const { totals } = priceHoldings([{ symbol: 'A', shares: 1, cost: null }], quotes);
    assert.equal(totals.dayChange, 10);
    assert.ok(Math.abs(totals.dayChangePercent - (10 / 90) * 100) < 1e-9);
  });
});
