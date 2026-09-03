/**
 * Tests for the recomputed score history.
 *
 * The two things that can quietly go wrong here are both about mixing up a
 * period with a year: summing a balance sheet across four quarters, and
 * comparing a quarter's revenue against a year's and calling the difference
 * growth. Both produce numbers that look entirely reasonable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildScoreHistory, trailingTwelveMonths, periodLabel, scoreOnDate } from '../lib/scoreHistory.js';

const MONTH = 30 * 86_400_000;

/** A quarter's statements, with flows sized so the sums are obvious. */
const quarter = (date, { revenue = 100, netIncome = 20, debt = 500, shares = 1000 } = {}) => ({
  date,
  totalRevenue: revenue,
  netIncome,
  dilutedEPS: netIncome / shares,
  operatingIncome: netIncome,
  ebitda: netIncome * 1.5,
  ebit: netIncome * 1.2,
  interestExpense: 5,
  depreciationAndAmortization: 10,
  operatingCashFlow: netIncome * 1.3,
  freeCashFlow: netIncome,
  capitalExpenditure: -netIncome * 0.3,
  cashDividendsPaid: -netIncome * 0.3,
  totalDebt: debt,
  cashAndCashEquivalents: 100,
  stockholdersEquity: 2000,
  totalAssets: 4000,
  dilutedAverageShares: shares,
});

/** Monthly closes rising steadily from `start`. */
const closes = (from, months, startPrice = 100, growth = 1.01) =>
  Array.from({ length: months }, (_, i) => ({
    t: from + i * MONTH,
    close: startPrice * growth ** i,
    adjClose: startPrice * growth ** i,
  }));

describe('trailingTwelveMonths', () => {
  test('sums flows and takes balances from the final quarter', () => {
    const ttm = trailingTwelveMonths([
      quarter('2025-03-31', { revenue: 100, netIncome: 10, debt: 900 }),
      quarter('2025-06-30', { revenue: 110, netIncome: 11, debt: 800 }),
      quarter('2025-09-30', { revenue: 120, netIncome: 12, debt: 700 }),
      quarter('2025-12-31', { revenue: 130, netIncome: 13, debt: 600 }),
    ]);

    assert.equal(ttm.totalRevenue, 460, 'revenue is the sum of four quarters');
    assert.equal(ttm.netIncome, 46);
    // Debt is a snapshot. Summing it would report 3000 of debt on a company
    // that owes 600, and every leverage ratio downstream would be five times
    // too high.
    assert.equal(ttm.totalDebt, 600, 'debt is the closing balance, not a sum');
    assert.equal(ttm.stockholdersEquity, 2000);
    assert.equal(ttm.date, '2025-12-31', 'dated at the end of the window');
  });

  test('annualises a partial window instead of leaving it ungraded', () => {
    // Yahoo keeps about five quarters, so the earliest quarter-ends never have
    // four behind them. Summing three as if they were a year would understate
    // every flow by a quarter and read as a collapse in revenue, so the average
    // quarter is scaled back up to a year instead.
    const three = trailingTwelveMonths([
      quarter('2025-06-30', { revenue: 100 }),
      quarter('2025-09-30', { revenue: 100 }),
      quarter('2025-12-31', { revenue: 100 }),
    ]);
    assert.equal(three.totalRevenue, 400, '300 over three quarters is 400 a year');
    assert.equal(three.quartersUsed, 3);

    const one = trailingTwelveMonths([quarter('2025-12-31', { revenue: 130 })]);
    assert.equal(one.totalRevenue, 520);
    assert.equal(one.quartersUsed, 1);

    assert.equal(trailingTwelveMonths([]), null, 'nothing to annualise from');
  });

  test('balances are never scaled up with the flows', () => {
    // Debt is a position, not a rate. Scaling one quarter's 600 to 2400 would
    // quadruple every leverage ratio downstream.
    const one = trailingTwelveMonths([quarter('2025-12-31', { netIncome: 10, debt: 600 })]);
    assert.equal(one.totalDebt, 600);
    assert.equal(one.stockholdersEquity, 2000);
    assert.equal(one.netIncome, 40, 'the flow is annualised');
  });

  test('a flow missing from any one quarter is not partially summed', () => {
    const q = [quarter('2025-03-31'), quarter('2025-06-30'), quarter('2025-09-30'), quarter('2025-12-31')];
    delete q[1].totalRevenue;
    assert.equal(trailingTwelveMonths(q).totalRevenue, null, 'partial totals are withheld, not reported');
    assert.equal(trailingTwelveMonths(q).netIncome, 80, 'other fields still sum');
  });
});

describe('periodLabel', () => {
  test('labels fiscal years and calendar quarters', () => {
    assert.equal(periodLabel('2025-09-30', false), 'FY2025');
    assert.equal(periodLabel('2025-03-31', true), 'Q1 2025');
    assert.equal(periodLabel('2025-12-31', true), 'Q4 2025');
    assert.equal(periodLabel('2025-07-31', true), 'Q3 2025');
  });
});

describe('buildScoreHistory', () => {
  const annualRows = ['2022-12-31', '2023-12-31', '2024-12-31', '2025-12-31'].map((d, i) =>
    quarter(d, { revenue: 400 + i * 40, netIncome: 80 + i * 8 }),
  );
  const priceHistory = closes(Date.UTC(2021, 0, 1), 72);

  test('grades every annual period it has a price for, newest first', () => {
    const h = buildScoreHistory({ financials: annualRows, closes: priceHistory, periodType: 'annual' });

    assert.equal(h.periods.length, 4);
    assert.deepEqual(
      h.periods.map((p) => p.label),
      ['FY2025', 'FY2024', 'FY2023', 'FY2022'],
    );
    for (const p of h.periods) {
      assert.ok(p.score >= 0 && p.score <= 100, `${p.label} scored ${p.score}`);
      assert.ok(p.grade, `${p.label} has a grade`);
    }
  });

  test('records how many reporting periods fed each grade', () => {
    const h = buildScoreHistory({ financials: annualRows, closes: priceHistory, periodType: 'annual' });
    // The earliest period is graded on one year of statements and the latest on
    // four. Without this the reader cannot tell a real decline from a change in
    // how much was known.
    assert.deepEqual(
      h.periods.map((p) => p.statementPeriods),
      [4, 3, 2, 1],
    );
  });

  test('the return is measured over the reporting period, not to today', () => {
    const h = buildScoreHistory({ financials: annualRows, closes: priceHistory, periodType: 'annual' });
    const fy2024 = h.periods.find((p) => p.label === 'FY2024');

    assert.equal(fy2024.windowStart, '2023-12-31', 'window starts at the prior period end');
    // Prices compound at 1% a month, so a year is about 12.7%.
    assert.ok(Math.abs(fy2024.totalReturn - 12.7) < 1.5, `got ${fy2024.totalReturn}`);
  });

  test('a period with no price history is named rather than dropped silently', () => {
    const h = buildScoreHistory({
      financials: annualRows,
      closes: closes(Date.UTC(2025, 0, 1), 12),
      periodType: 'annual',
    });
    assert.ok(h.unscored.length >= 3);
    assert.ok(h.unscored.every((u) => u.reason === 'no price history at this date'));
  });

  test('every quarter-end is graded, annualised from what is behind it', () => {
    const quarters = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'].map((d) => quarter(d));
    const h = buildScoreHistory({ financials: quarters, closes: priceHistory, periodType: 'quarterly' });

    assert.equal(h.periods.length, 4);
    assert.deepEqual(
      h.periods.map((p) => p.label),
      ['Q4 2025', 'Q3 2025', 'Q2 2025', 'Q1 2025'],
    );
    // Newest first, so the counts run 4, 3, 2, 1 back through the year.
    assert.deepEqual(
      h.periods.map((p) => p.quartersUsed),
      [4, 3, 2, 1],
    );
  });

  test('a quarterly grade uses the trailing year, not the single quarter', () => {
    const quarters = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'].map((d) => quarter(d, { revenue: 100 }));
    const h = buildScoreHistory({ financials: quarters, closes: priceHistory, periodType: 'quarterly' });

    // Grading the quarter-end must be the same as grading the folded year, and
    // must NOT be the same as grading the bare final quarter. The second half
    // is the one that matters: a single quarter run through a scorer that
    // reasons in years reads as a company a quarter of its real size.
    const asFoldedYear = buildScoreHistory({
      financials: [trailingTwelveMonths(quarters)],
      closes: priceHistory,
      periodType: 'annual',
    });
    const asBareQuarter = buildScoreHistory({
      financials: [quarters.at(-1)],
      closes: priceHistory,
      periodType: 'annual',
    });

    assert.equal(h.periods[0].score, asFoldedYear.periods[0].score, 'graded on the folded year');
    assert.notEqual(h.periods[0].score, asBareQuarter.periods[0].score, 'not graded on the bare quarter');
  });

  test('empty inputs produce an empty history rather than throwing', () => {
    const h = buildScoreHistory({});
    assert.deepEqual(h.periods, []);
    assert.deepEqual(h.unscored, []);
  });
});

describe('scoreOnDate', () => {
  /*
   * The reason this exists. buildScoreHistory scores each reporting period at
   * that period's own end, so a score read off it cannot move between
   * earnings — and a month of score movers came back with every company
   * unchanged, which was an artefact of where the score was sampled rather
   * than a fact about the market.
   */
  // `quarter` is the shared row builder; used here for annual periods, as the
  // suite above does.
  const annual = ['2023-12-31', '2024-12-31', '2025-12-31'].map((d, i) =>
    quarter(d, { revenue: 1000 + i * 100, netIncome: 100 + i * 10 }),
  );

  /** The same company at a flat price, so only the date varies. */
  const flatAt = (price, date) =>
    scoreOnDate({
      financials: annual,
      closes: Array.from({ length: 40 }, (_, i) => ({
        t: Date.UTC(2024, 0, 1) + i * MONTH,
        close: price,
        adjClose: price,
      })),
      periodType: 'annual',
      date,
    });

  test('moves between earnings, because the price does', () => {
    // Identical statements at both ends. Only the price differs, and that has
    // to be enough to move the score, or a month of movers is empty.
    // EPS here is 0.12, so these straddle the band the valuation pillar
    // actually responds over: about ten to fifty times earnings.
    const cheap = flatAt(2, '2026-06-01');
    const dear = flatAt(5, '2026-06-01');
    assert.equal(cheap.period, dear.period, 'both rest on the same statements');
    assert.notEqual(cheap.score, dear.score);
    assert.ok(dear.score < cheap.score, 'paying two and a half times as much for the same earnings scores worse');
  });

  test('the price sensitivity runs out, and that is a real limit', () => {
    /*
     * Worth pinning down rather than discovering later. Without the valuation
     * context the live score gets — the multiple against the company's own
     * history and against its peers — the only price-sensitive part left is the
     * absolute band, and that bottoms out. Past roughly forty times earnings
     * this company scores the same whatever it costs, so a reconstructed score
     * understates how much an expensive company's score really moved.
     */
    const dear = flatAt(20, '2026-06-01');
    const dearer = flatAt(200, '2026-06-01');
    assert.equal(dearer.score, dear.score, 'ten times the price, same score: the pillar has saturated');
  });

  test('never reads statements published after the date', () => {
    // The look-ahead that would make any of this meaningless.
    const rising = closes(Date.UTC(2024, 0, 1), 36);
    const before = scoreOnDate({ financials: annual, closes: rising, periodType: 'annual', date: '2025-06-30' });
    assert.equal(before.period, '2024-12-31', 'the 2025 statements had not closed yet');
  });

  test('has nothing to say before the first statements closed', () => {
    const rising = closes(Date.UTC(2024, 0, 1), 36);
    assert.equal(scoreOnDate({ financials: annual, closes: rising, periodType: 'annual', date: '2023-01-01' }), null);
  });

  test('refuses a date with no price behind it rather than guessing one', () => {
    assert.equal(scoreOnDate({ financials: annual, closes: [], periodType: 'annual', date: '2026-01-01' }), null);
    assert.equal(scoreOnDate({ financials: annual, closes: closes(Date.UTC(2024, 0, 1), 36) }), null, "no date at all");
    assert.equal(scoreOnDate(), null);
  });
});
