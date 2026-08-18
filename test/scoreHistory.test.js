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

import { buildScoreHistory, trailingTwelveMonths, periodLabel } from '../lib/scoreHistory.js';

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

  test('refuses to build a year from fewer than four quarters', () => {
    // Three quarters summed as a year understates every flow by a quarter and
    // reads as a sudden collapse in revenue.
    assert.equal(trailingTwelveMonths([quarter('2025-06-30'), quarter('2025-09-30'), quarter('2025-12-31')]), null);
    assert.equal(trailingTwelveMonths([]), null);
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

  test('quarters are graded on a trailing year, so four quarters yield one grade', () => {
    const quarters = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'].map((d) => quarter(d));
    const h = buildScoreHistory({ financials: quarters, closes: priceHistory, periodType: 'quarterly' });

    // Only the fourth quarter-end has a complete year behind it.
    assert.equal(h.periods.length, 1);
    assert.equal(h.periods[0].label, 'Q4 2025');
    assert.equal(h.unscored.length, 3);
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
