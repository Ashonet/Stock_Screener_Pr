/**
 * Tests for dividend income attribution.
 *
 * The cases that matter here are the boundaries, because every one of them is
 * a way to report income the wallet never received: counting the payment that
 * went ex on the day you bought, counting a payer you hold with no purchase
 * date on record, or dropping months that paid nothing and flattering the
 * monthly average.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildIncome, buildIncomeProjection } from '../lib/income.js';
import { parseHoldings, parseDate } from '../lib/portfolio.js';

const dividends = (entries) => new Map(entries);

/** Quarterly payments of a fixed amount, on the 15th. */
const quarterly = (year, count, perShare) =>
  Array.from({ length: count }, (_, i) => ({
    exDate: `${year + Math.floor(i / 4)}-${String((i % 4) * 3 + 1).padStart(2, '0')}-15`,
    perShare,
  }));

describe('buildIncome eligibility', () => {
  test('counts only payments that went ex after the purchase date', () => {
    const record = dividends([['KO', quarterly(2024, 4, 0.5)]]);
    const income = buildIncome([{ symbol: 'KO', shares: 100, boughtAt: '2024-06-01' }], record, { asOf: '2025-01-01' });

    // Jan and Apr are before the purchase; Jul and Oct are after.
    assert.equal(income.payments.length, 2);
    assert.deepEqual(
      income.payments.map((p) => p.exDate),
      ['2024-10-15', '2024-07-15'],
    );
    assert.equal(income.totals.total, 100);
  });

  test('buying on the ex-date pays nothing, so that payment is excluded', () => {
    // The rule is strictly-after, not on-or-after: an ex-date buyer does not
    // receive the distribution. Off-by-one here inflates every first year.
    const record = dividends([['KO', [{ exDate: '2024-07-15', perShare: 0.5 }]]]);
    const income = buildIncome([{ symbol: 'KO', shares: 100, boughtAt: '2024-07-15' }], record, { asOf: '2025-01-01' });

    assert.equal(income.payments.length, 0);
    assert.deepEqual(income.excluded, [{ symbol: 'KO', reason: 'none-since-purchase' }]);
  });

  test('a holding with no purchase date is named, never assumed', () => {
    const record = dividends([['KO', quarterly(2020, 20, 0.5)]]);
    const income = buildIncome([{ symbol: 'KO', shares: 100, boughtAt: null }], record, { asOf: '2025-01-01' });

    assert.equal(income.totals.total, 0);
    assert.deepEqual(income.excluded, [{ symbol: 'KO', reason: 'no-purchase-date' }]);
  });

  test('a non-payer is reported as having no record rather than as zero income', () => {
    const income = buildIncome([{ symbol: 'NVDA', shares: 10, boughtAt: '2020-01-01' }], new Map(), { asOf: '2025-01-01' });
    assert.deepEqual(income.excluded, [{ symbol: 'NVDA', reason: 'no-dividend-record' }]);
  });

  test('payments after the as-of date are ignored', () => {
    const record = dividends([['O', [{ exDate: '2026-12-31', perShare: 0.27 }]]]);
    const income = buildIncome([{ symbol: 'O', shares: 100, boughtAt: '2020-01-01' }], record, { asOf: '2026-06-30' });
    assert.equal(income.payments.length, 0);
  });
});

describe('buildIncome aggregation', () => {
  test('a month that paid nothing still appears in the series', () => {
    // Without the gap months a quarterly payer draws as four adjacent bars and
    // looks exactly like a monthly one.
    const record = dividends([['KO', quarterly(2024, 4, 0.5)]]);
    const income = buildIncome([{ symbol: 'KO', shares: 100, boughtAt: '2023-12-01' }], record, { asOf: '2024-12-31' });

    assert.equal(income.months.length, 10); // Jan to Oct inclusive
    assert.deepEqual(income.months.slice(0, 3), [
      { month: '2024-01', amount: 50 },
      { month: '2024-02', amount: 0 },
      { month: '2024-03', amount: 0 },
    ]);
  });

  test('the monthly average excludes the month still in progress', () => {
    const record = dividends([['O', [
      { exDate: '2024-01-10', perShare: 1 },
      { exDate: '2024-02-10', perShare: 1 },
      { exDate: '2024-03-10', perShare: 1 },
    ]]]);
    const income = buildIncome([{ symbol: 'O', shares: 100, boughtAt: '2023-12-01' }], record, { asOf: '2024-03-20' });

    // March is incomplete, so the average is over January and February only.
    assert.equal(income.totals.monthlyAverage, 100);
  });

  test('totals split by symbol, largest first', () => {
    const record = dividends([
      ['O', [{ exDate: '2024-02-10', perShare: 0.25 }]],
      ['KO', [{ exDate: '2024-02-15', perShare: 0.5 }]],
    ]);
    const income = buildIncome(
      [
        { symbol: 'O', shares: 100, boughtAt: '2023-01-01' },
        { symbol: 'KO', shares: 200, boughtAt: '2023-01-01' },
      ],
      record,
      { asOf: '2024-06-01' },
    );

    assert.deepEqual(
      income.bySymbol.map((r) => [r.symbol, r.amount]),
      [
        ['KO', 100],
        ['O', 25],
      ],
    );
    assert.equal(income.totals.total, 125);
    assert.equal(income.totals.symbolCount, 2);
  });

  test('an empty wallet produces an empty record rather than throwing', () => {
    const income = buildIncome([], new Map(), { asOf: '2025-01-01' });
    assert.deepEqual(income.payments, []);
    assert.deepEqual(income.months, []);
    assert.equal(income.totals.monthlyAverage, null);
    assert.equal(income.totals.bestMonth, null);
  });
});

describe('purchase dates on the wire', () => {
  test('the holdings parameter round-trips a date', () => {
    const [holding] = parseHoldings('AAPL:10:150.25:2024-03-08');
    assert.deepEqual(holding, { symbol: 'AAPL', shares: 10, cost: 150.25, boughtAt: '2024-03-08' });
  });

  test('a date can be given without a cost basis', () => {
    const [holding] = parseHoldings('AAPL:10::2024-03-08');
    assert.equal(holding.cost, null);
    assert.equal(holding.boughtAt, '2024-03-08');
  });

  test('a date that never existed is rejected, not rolled forward', () => {
    // new Date('2025-02-30') silently becomes 2 March. Accepting it would shift
    // a position's income window to a day it was never bought on.
    assert.equal(parseDate('2025-02-30'), null);
    assert.equal(parseDate('2024-02-29'), '2024-02-29'); // a real leap day
  });

  test('a future purchase date is rejected', () => {
    const nextYear = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    assert.equal(parseDate(nextYear), null);
  });

  test('junk in the date slot leaves the holding usable', () => {
    const [holding] = parseHoldings('AAPL:10:150:not-a-date');
    assert.equal(holding.boughtAt, null);
    assert.equal(holding.shares, 10);
  });
});

describe('buildIncomeProjection', () => {
  /** Quarterly payments growing at a fixed rate, `years` of them. */
  const growing = (startPerShare, ratePct, years) => {
    const out = [];
    for (let y = 0; y < years; y++) {
      const perShare = (startPerShare * (1 + ratePct / 100) ** y) / 4;
      for (let q = 0; q < 4; q++) {
        const month = String(q * 3 + 1).padStart(2, '0');
        out.push({ exDate: `${2020 + y}-${month}-15`, perShare });
      }
    }
    return out;
  };

  test('grows each holding at its own measured rate', () => {
    const record = new Map([['KO', growing(2, 10, 6)]]);
    const p = buildIncomeProjection([{ symbol: 'KO', shares: 100 }], record, { years: 5, asOf: '2025-12-31' });
    const [row] = p.rows;

    assert.ok(Math.abs(row.growthPct - 10) < 0.5, `measured ${row.growthPct}`);
    // Five years of 10% compounding is about 1.61x.
    assert.ok(Math.abs(row.projected.at(-1).amount / row.currentAnnual - 1.61) < 0.05);
    assert.equal(row.projected.length, 5);
  });

  test('a holding with too little record is projected flat, not guessed at', () => {
    const record = new Map([['NEW', [{ exDate: '2025-06-15', perShare: 1 }]]]);
    const p = buildIncomeProjection([{ symbol: 'NEW', shares: 10 }], record, { years: 5, asOf: '2025-12-31' });
    const [row] = p.rows;

    assert.equal(row.growthPct, null);
    assert.equal(row.projected.at(-1).amount, row.currentAnnual, 'flat, not zero and not invented');
  });

  test('a non-payer and a lapsed payer are named, not projected as zero', () => {
    const record = new Map([
      ['OLD', [{ exDate: '2019-01-15', perShare: 1 }]],
      ['NONE', []],
    ]);
    const p = buildIncomeProjection(
      [
        { symbol: 'OLD', shares: 10 },
        { symbol: 'NONE', shares: 10 },
        { symbol: 'MISSING', shares: 10 },
      ],
      record,
      { asOf: '2025-12-31' },
    );

    assert.equal(p.rows.length, 0);
    assert.deepEqual(
      p.excluded.map((e) => e.reason).sort(),
      ['no-dividend-record', 'no-dividend-record', 'nothing-paid-in-the-last-year'],
    );
  });

  test('blended growth is weighted by income, so a tiny holding cannot dominate', () => {
    // A large slow payer and a tiny fast one. A simple mean of the two rates
    // would report ~40%; the blend must sit near the payer that provides the
    // income.
    const record = new Map([
      ['BIG', growing(4, 5, 6)],
      ['TINY', growing(0.01, 75, 6)],
    ]);
    const p = buildIncomeProjection(
      [
        { symbol: 'BIG', shares: 1000 },
        { symbol: 'TINY', shares: 1 },
      ],
      record,
      { asOf: '2025-12-31' },
    );

    assert.ok(p.totals.blendedGrowth < 6, `blended ${p.totals.blendedGrowth} should stay near BIG's rate`);
  });

  test('an unsustainable rate is flagged rather than capped', () => {
    const record = new Map([['FAST', growing(0.05, 77, 6)]]);
    const p = buildIncomeProjection([{ symbol: 'FAST', shares: 10 }], record, { asOf: '2025-12-31' });

    assert.equal(p.rows[0].fastGrowth, true);
    // Kept as measured: capping would substitute a different number without
    // saying so.
    assert.ok(p.rows[0].growthPct > 70);
  });

  test('portfolio totals add up across holdings and years', () => {
    const record = new Map([
      ['A', growing(2, 10, 6)],
      ['B', growing(1, 0, 6)],
    ]);
    const p = buildIncomeProjection(
      [
        { symbol: 'A', shares: 100 },
        { symbol: 'B', shares: 100 },
      ],
      record,
      { years: 3, asOf: '2025-12-31' },
    );

    assert.equal(p.byYear.length, 3);
    for (let i = 0; i < 3; i++) {
      const expected = p.rows.reduce((sum, r) => sum + r.projected[i].amount, 0);
      assert.ok(Math.abs(p.byYear[i].amount - expected) < 1e-9);
    }
    assert.ok(p.totals.currentAnnual > 0);
  });

  test('an empty wallet projects nothing rather than throwing', () => {
    const p = buildIncomeProjection([], new Map(), { asOf: '2025-12-31' });
    assert.deepEqual(p.rows, []);
    assert.equal(p.totals.currentAnnual, 0);
    assert.equal(p.totals.blendedGrowth, null);
  });
});
