/**
 * Tests for valuation in context.
 *
 * The traps here are all arithmetic that produces a plausible-looking number
 * from data that cannot support one. A negative P/E sorts to the top of a
 * cheapest-first list; a company earning a cent a share prints a multiple in
 * the thousands; a mean of four peers where one trades at 400x lands on a value
 * no member of the group is near. Each of those would be a screen quietly
 * recommending the worst thing it can find, so each has a test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  median,
  percentileOf,
  multipleSeries,
  versusOwnHistory,
  versusPeers,
  valuationContext,
  usableMultiple,
  IMPLAUSIBLE_MULTIPLE,
} from '../lib/valuation.js';

/** Monthly closes starting at a date, for building a series long enough to pass. */
const monthly = (count, close, startYear = 2022) =>
  Array.from({ length: count }, (_, i) => ({
    date: `${startYear + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`,
    close: typeof close === 'function' ? close(i) : close,
  }));

const peer = (symbol, multiple, over = {}) => ({
  symbol,
  multiple,
  industry: 'Software',
  sector: 'Technology',
  isReit: false,
  ...over,
});

describe('median', () => {
  test('takes the middle of an odd sample and the midpoint of an even one', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  test('is not dragged by a single extreme, which is why it is used', () => {
    // The mean of these is 103.25 and no member of the group is near it.
    assert.equal(median([10, 12, 14, 377]), 13);
  });

  test('an empty sample has no median rather than a zero', () => {
    assert.equal(median([]), null);
    assert.equal(median([null, undefined, NaN]), null);
  });
});

describe('usableMultiple', () => {
  test('rejects the multiples that are arithmetic rather than valuation', () => {
    assert.equal(usableMultiple(18), true);
    assert.equal(usableMultiple(-12), false, 'a loss-maker is not cheap');
    assert.equal(usableMultiple(0), false);
    assert.equal(usableMultiple(IMPLAUSIBLE_MULTIPLE + 1), false, 'denominator near zero');
    assert.equal(usableMultiple(Infinity), false);
    assert.equal(usableMultiple(null), false);
  });
});

describe('percentileOf', () => {
  test('reports the share of the sample at or below the value', () => {
    assert.equal(percentileOf(3, [1, 2, 3, 4]), 75);
    assert.equal(percentileOf(1, [1, 2, 3, 4]), 25);
  });

  test('an empty sample yields nothing rather than a zero', () => {
    assert.equal(percentileOf(5, []), null);
  });
});

describe('multipleSeries', () => {
  const earnings = [
    { date: '2022-12-31', eps: 5 },
    { date: '2023-12-31', eps: 10 },
  ];

  test('prices against the earnings that had been published by then', () => {
    // 2023-06-01 is after FY2022 became reportable (2022-12-31 + 90d) and long
    // before FY2023 did, so it must use the 5.00 figure, not the 10.00 one.
    const series = multipleSeries([{ date: '2023-06-01', close: 100 }], earnings);
    assert.equal(series.length, 1);
    assert.equal(series[0].eps, 5);
    assert.equal(series[0].multiple, 20);
  });

  test('does not use earnings before they could have been published', () => {
    // The day FY2022 ended, nobody knew what FY2022 earned.
    const series = multipleSeries([{ date: '2022-12-31', close: 100 }], earnings);
    assert.deepEqual(series, [], 'lookahead bias would have priced this point');
  });

  test('switches to the new year once the reporting lag has passed', () => {
    const series = multipleSeries([{ date: '2024-06-01', close: 100 }], earnings);
    assert.equal(series[0].eps, 10, 'FY2023 is public by mid-2024');
    assert.equal(series[0].multiple, 10);
  });

  test('a loss-making year produces no multiple rather than a negative one', () => {
    const series = multipleSeries(
      [{ date: '2024-06-01', close: 100 }],
      [{ date: '2023-12-31', eps: -4 }],
    );
    assert.deepEqual(series, []);
  });

  test('does not carry the last profitable year forward over a loss', () => {
    // Valuing a company on earnings it no longer has is the subtle version of
    // the same mistake: it would report a healthy multiple through the loss.
    const series = multipleSeries(
      [{ date: '2025-06-01', close: 100 }],
      [
        { date: '2022-12-31', eps: 5 },
        { date: '2024-12-31', eps: -2 },
      ],
    );
    assert.deepEqual(series, [], 'the loss year is the applicable one');
  });

  test('a period with no reported figure falls back to the last reported one', () => {
    // The mirror of the loss rule, and the opposite answer. A null is absent
    // data, so the previous report is still the best available basis; a
    // negative is real data and must not be skipped. Clorox has a null FY2025
    // EPS, and treating it as the applicable period dropped it out of every
    // peer group rather than pricing it on FY2024.
    const series = multipleSeries(
      [{ date: '2026-06-01', close: 100 }],
      [
        { date: '2023-12-31', eps: 4 },
        { date: '2024-12-31', eps: null },
      ],
    );
    assert.equal(series.length, 1, 'the null year is skipped, not landed on');
    assert.equal(series[0].eps, 4);
  });

  test('drops multiples produced by a denominator near zero', () => {
    const series = multipleSeries(
      [{ date: '2024-06-01', close: 50 }],
      [{ date: '2023-12-31', eps: 0.01 }],
    );
    assert.deepEqual(series, [], '5,000x is a rounding error, not a valuation');
  });

  test('no earnings at all yields an empty series rather than throwing', () => {
    assert.deepEqual(multipleSeries([{ date: '2024-01-01', close: 10 }], []), []);
    assert.deepEqual(multipleSeries(), []);
  });
});

describe('versusOwnHistory', () => {
  const flat = monthly(36, 20).map((p) => ({ date: p.date, multiple: 20 }));

  test('reports a multiple below its own median as cheaper than usual', () => {
    const result = versusOwnHistory(flat, 14);
    assert.equal(result.median, 20);
    assert.ok(Math.abs(result.ratio - 0.7) < 1e-9, 'ratio below 1 is cheaper');
    assert.equal(result.observations, 36);
  });

  test('reports a multiple above its own median as dearer than usual', () => {
    assert.ok(versusOwnHistory(flat, 30).ratio > 1);
  });

  test('withholds a verdict on too little history', () => {
    const short = flat.slice(0, 12);
    assert.equal(versusOwnHistory(short, 14), null, '12 months is not a history');
  });

  test('a loss-making present has no multiple to place', () => {
    assert.equal(versusOwnHistory(flat, -8), null);
  });

  test('places the current multiple in its own distribution', () => {
    const rising = Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, multiple: 10 + i }));
    // 12 sits below all but the first two of 10..49.
    assert.ok(versusOwnHistory(rising, 12).percentile < 10);
  });
});

describe('versusPeers', () => {
  const self = peer('SELF', 30);

  test('compares against the industry when it is big enough', () => {
    const result = versusPeers(self, [
      peer('A', 10),
      peer('B', 15),
      peer('C', 20),
      peer('D', 25),
      peer('E', 30),
    ]);
    assert.equal(result.basis, 'industry');
    assert.equal(result.median, 20);
    assert.equal(result.ratio, 1.5, 'dearer than its industry');
    assert.equal(result.count, 5);
  });

  test('widens to the sector when the industry is too thin, and says so', () => {
    const result = versusPeers(self, [
      peer('A', 10),
      peer('B', 20, { industry: 'Semiconductors' }),
      peer('C', 20, { industry: 'Semiconductors' }),
      peer('D', 30, { industry: 'Hardware' }),
      peer('E', 30, { industry: 'Hardware' }),
      peer('F', 40, { industry: 'Hardware' }),
    ]);
    assert.equal(result.basis, 'sector', 'two software peers is not a comparison');
    assert.equal(result.count, 6);
  });

  test('a company is not its own peer', () => {
    const result = versusPeers(self, [
      peer('SELF', 999),
      peer('A', 10),
      peer('B', 10),
      peer('C', 10),
      peer('D', 10),
      peer('E', 10),
    ]);
    assert.equal(result.count, 5);
    assert.equal(result.median, 10, 'including itself would drag the median it is measured against');
  });

  test('REITs are compared only against REITs', () => {
    const reit = peer('REIT', 40, { isReit: true, industry: 'REIT - Retail', sector: 'Real Estate' });
    const result = versusPeers(reit, [
      ...Array.from({ length: 6 }, (_, i) => peer(`OP${i}`, 15, { sector: 'Real Estate' })),
      ...Array.from({ length: 5 }, (_, i) =>
        peer(`R${i}`, 38, { isReit: true, industry: 'REIT - Retail', sector: 'Real Estate' }),
      ),
    ]);
    assert.equal(result.count, 5, 'the operating companies are not comparable');
    assert.equal(result.median, 38);
  });

  test('loss-making peers are excluded rather than counted as cheap', () => {
    const result = versusPeers(self, [
      peer('A', -50),
      peer('B', -20),
      peer('C', 20),
      peer('D', 20),
      peer('E', 20),
    ]);
    assert.equal(result, null, 'only three usable peers is below the floor');
  });

  test('withholds a verdict when no grouping is big enough', () => {
    assert.equal(versusPeers(self, [peer('A', 10), peer('B', 12)]), null);
  });

  test('a loss-making company has no multiple to compare', () => {
    const result = versusPeers(peer('SELF', -10), Array.from({ length: 6 }, (_, i) => peer(`P${i}`, 20)));
    assert.equal(result, null);
  });
});

describe('valuationContext', () => {
  const series = Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, multiple: 20 }));
  const peers = Array.from({ length: 6 }, (_, i) => peer(`P${i}`, 25));

  test('reports both readings when both are supported', () => {
    const result = valuationContext({
      series,
      current: 20,
      self: peer('SELF', 20),
      peers,
    });
    assert.ok(result.own, 'has its own history');
    assert.ok(result.peers, 'has peers');
    assert.deepEqual(result.unavailable, []);
  });

  test('names why a reading is missing instead of showing a blank', () => {
    const result = valuationContext({ series: [], current: 20, self: peer('SELF', 20), peers: [] });
    assert.equal(result.own, null);
    assert.equal(result.peers, null);
    assert.equal(result.unavailable.length, 2);
    assert.match(result.unavailable[0], /history/);
  });

  test('a loss-maker is explained as such, not as expensive', () => {
    const result = valuationContext({ series, current: -5, self: peer('SELF', -5), peers });
    assert.match(result.unavailable.join(' '), /no positive earnings/);
  });

  test('survives being called with nothing', () => {
    const result = valuationContext();
    assert.equal(result.own, null);
    assert.equal(result.peers, null);
  });
});
