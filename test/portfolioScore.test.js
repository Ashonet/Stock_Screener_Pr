/**
 * Tests for the wallet's weighted score history.
 *
 * The two failures worth guarding are both ways of reporting a portfolio nobody
 * owned: counting a holding before it was bought, and letting a tiny position
 * carry the same vote as a large one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildPortfolioScoreHistory } from '../lib/portfolioScore.js';

const MONTH = 30 * 86_400_000;
const t0 = Date.UTC(2024, 0, 1);

/** Monthly closes at a flat price, so weights come only from share counts. */
const flat = (price, months = 6) => Array.from({ length: months }, (_, i) => ({ t: t0 + i * MONTH, close: price }));

const timeline = (pairs) => pairs.map(([period, score, grade]) => ({ period, score, grade }));

describe('buildPortfolioScoreHistory', () => {
  test('weights by position value, not by holding count', () => {
    // A 100-dollar position scoring 20 against a 9,900-dollar one scoring 90.
    // An equal-weight average would say 55; the portfolio is 89.3.
    const result = buildPortfolioScoreHistory({
      holdings: [
        { symbol: 'SMALL', shares: 1, boughtAt: '2024-01-01' },
        { symbol: 'BIG', shares: 99, boughtAt: '2024-01-01' },
      ],
      timelines: new Map([
        ['SMALL', timeline([['2023-12-31', 20, 'F']])],
        ['BIG', timeline([['2023-12-31', 90, 'A+']])],
      ]),
      prices: new Map([
        ['SMALL', flat(100)],
        ['BIG', flat(100)],
      ]),
    });

    assert.ok(Math.abs(result.current.score - 89.3) < 0.1, `got ${result.current.score}`);
  });

  test('a holding does not count before it was bought', () => {
    // One C-graded company alone, then an A-graded one joins in month three.
    // The line has to start at 50 and step up, not sit at the blend throughout.
    const result = buildPortfolioScoreHistory({
      holdings: [
        { symbol: 'FIRST', shares: 1, boughtAt: '2024-01-01' },
        { symbol: 'LATER', shares: 1, boughtAt: '2024-03-15' },
      ],
      timelines: new Map([
        ['FIRST', timeline([['2023-12-31', 50, 'C']])],
        ['LATER', timeline([['2023-12-31', 90, 'A+']])],
      ]),
      prices: new Map([
        ['FIRST', flat(100)],
        ['LATER', flat(100)],
      ]),
    });

    assert.equal(result.points[0].c, 50, 'opens on the holding that was owned');
    assert.equal(result.points.at(-1).c, 70, 'blends once the second is bought');
    const stepped = result.points.findIndex((p) => p.c > 50);
    assert.ok(result.points[stepped].t >= Date.parse('2024-03-15T00:00:00Z'));
  });

  test('a grade change moves the line on its own', () => {
    const result = buildPortfolioScoreHistory({
      holdings: [{ symbol: 'ONE', shares: 1, boughtAt: '2024-01-01' }],
      timelines: new Map([['ONE', timeline([['2023-12-31', 40, 'D'], ['2024-03-31', 80, 'A']])]]),
      prices: new Map([['ONE', flat(100)]]),
    });

    assert.equal(result.points[0].c, 40);
    assert.equal(result.points.at(-1).c, 80, 'the new report takes effect');
  });

  test('a grade is never applied before the period it came from closed', () => {
    // Look-ahead in miniature: the FY2024 grade cannot govern January 2024.
    const result = buildPortfolioScoreHistory({
      holdings: [{ symbol: 'ONE', shares: 1, boughtAt: '2024-01-01' }],
      timelines: new Map([['ONE', timeline([['2024-05-31', 80, 'A']])]]),
      prices: new Map([['ONE', flat(100, 10)]]),
    });

    assert.ok(result.points.length > 0);
    for (const point of result.points) {
      assert.ok(point.t >= Date.parse('2024-05-31T00:00:00Z'), 'no point predates the grade');
    }
  });

  test('an ungraded holding is excluded, never counted as zero', () => {
    // Counting it as zero would report a portfolio of good companies as
    // mediocre, which says something about our coverage and nothing about the
    // portfolio.
    const result = buildPortfolioScoreHistory({
      holdings: [
        { symbol: 'GRADED', shares: 1, boughtAt: '2024-01-01' },
        { symbol: 'UNRATED', shares: 1, boughtAt: '2024-01-01' },
      ],
      timelines: new Map([['GRADED', timeline([['2023-12-31', 80, 'A']])]]),
      prices: new Map([
        ['GRADED', flat(100)],
        ['UNRATED', flat(100)],
      ]),
    });

    assert.equal(result.current.score, 80, 'not 40');
    assert.equal(result.current.coverage, 50, 'and it says half the value is ungraded');
    assert.deepEqual(result.excluded, [{ symbol: 'UNRATED', reason: 'not scored' }]);
  });

  test('composition reports each holding weight against the graded value', () => {
    const result = buildPortfolioScoreHistory({
      holdings: [
        { symbol: 'A', shares: 3, boughtAt: '2024-01-01' },
        { symbol: 'B', shares: 1, boughtAt: '2024-01-01' },
      ],
      timelines: new Map([
        ['A', timeline([['2023-12-31', 60, 'C+']])],
        ['B', timeline([['2023-12-31', 100, 'A+']])],
      ]),
      prices: new Map([
        ['A', flat(100)],
        ['B', flat(100)],
      ]),
    });

    assert.deepEqual(
      result.holdings.map((h) => [h.symbol, Math.round(h.weight)]),
      [
        ['A', 75],
        ['B', 25],
      ],
    );
    assert.equal(result.current.score, 70);
  });

  test('nothing scoreable yields an empty history rather than throwing', () => {
    assert.deepEqual(buildPortfolioScoreHistory({}).points, []);
    const none = buildPortfolioScoreHistory({
      holdings: [{ symbol: 'X', shares: 1, boughtAt: '2024-01-01' }],
      timelines: new Map(),
      prices: new Map(),
    });
    assert.equal(none.current, null);
    assert.deepEqual(none.excluded, [{ symbol: 'X', reason: 'no price history' }]);
  });
});
