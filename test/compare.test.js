/**
 * Tests for the compare view's rebasing maths.
 *
 * The failure this guards against is a series that starts partway across the
 * plot: if a late-listing name is rebased at its own first close, its line
 * begins at the same height as everyone else's but means something different,
 * and the whole comparison is silently wrong.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildComparison } from '../lib/compare.js';

const day = 86_400_000;
const t0 = Date.UTC(2020, 0, 1);

/** Points at monthly spacing; `adj` defaults to no distributions at all. */
const points = (closes, adj = closes) =>
  closes.map((close, i) => ({ t: t0 + i * 30 * day, close, adjClose: adj[i] }));

describe('buildComparison', () => {
  test('rebases every series to the same starting amount', () => {
    const result = buildComparison(
      new Map([
        ['CHEAP', points([10, 20])],
        ['DEAR', points([1000, 1500])],
      ]),
    );

    for (const series of result.series) {
      assert.equal(series.price[0].c, 10_000, `${series.symbol} starts at the base`);
    }
    assert.equal(result.series.find((s) => s.symbol === 'CHEAP').priceReturn, 100);
    assert.equal(result.series.find((s) => s.symbol === 'DEAR').priceReturn, 50);
  });

  test('starts where every series has a price, not at the earliest one', () => {
    const early = points([100, 110, 120, 130]);
    const late = [{ t: t0 + 60 * day, close: 50, adjClose: 50 }, { t: t0 + 90 * day, close: 60, adjClose: 60 }];

    const result = buildComparison(new Map([['OLD', early], ['NEW', late]]));

    assert.equal(result.startedAt, t0 + 60 * day);
    // The older name is rebased at its price on the shared start date, not at
    // its own first close, so both lines answer the same question.
    const old = result.series.find((s) => s.symbol === 'OLD');
    assert.equal(old.price[0].c, 10_000);
    assert.equal(old.price.length, 2);
    assert.ok(Math.abs(old.priceReturn - (130 / 120 - 1) * 100) < 1e-9);
  });

  test('separates the dividend contribution from the price move', () => {
    // Price doubles; adjusted triples. The extra 100 points is distributions.
    const result = buildComparison(new Map([['O', points([100, 200], [100, 300])]]));
    const [series] = result.series;

    assert.equal(series.priceReturn, 100);
    assert.equal(series.totalReturn, 200);
    assert.equal(series.dividendContribution, 100);
    assert.equal(series.dividendShare, 50);
  });

  test('a non-payer shows no dividend contribution', () => {
    const result = buildComparison(new Map([['NVDA', points([100, 500])]]));
    assert.equal(result.series[0].dividendContribution, 0);
    assert.equal(result.series[0].dividendShare, 0);
  });

  test('a losing position reports no dividend share rather than a share of a loss', () => {
    const result = buildComparison(new Map([['BAD', points([100, 50], [100, 60])]]));
    const [series] = result.series;

    assert.ok(series.totalReturn < 0);
    assert.equal(series.dividendShare, null);
    // The contribution itself is still a real number and is kept.
    assert.equal(series.dividendContribution, 10);
  });

  test('series are ordered by total return, best first', () => {
    const result = buildComparison(
      new Map([
        ['MID', points([100, 150])],
        ['BEST', points([100, 300])],
        ['WORST', points([100, 110])],
      ]),
    );
    assert.deepEqual(
      result.series.map((s) => s.symbol),
      ['BEST', 'MID', 'WORST'],
    );
  });

  test('a series too short to rebase is dropped and named', () => {
    const result = buildComparison(new Map([['OK', points([100, 200])], ['THIN', points([100])]]));
    assert.deepEqual(result.dropped, ['THIN']);
    assert.equal(result.series.length, 1);
  });

  test('nothing usable yields an empty comparison rather than throwing', () => {
    const result = buildComparison(new Map());
    assert.deepEqual(result.series, []);
    assert.equal(result.startedAt, null);
  });

  test('CAGR is withheld on a window shorter than a year', () => {
    const short = [
      { t: t0, close: 100, adjClose: 100 },
      { t: t0 + 60 * day, close: 200, adjClose: 200 },
    ];
    assert.equal(buildComparison(new Map([['X', short]])).series[0].totalCagr, null);
  });
});
