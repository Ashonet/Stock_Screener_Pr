/**
 * Tests for the scoring model's branch logic.
 *
 * The point of these is the REIT branch: the whole model turns on it, and a
 * regression there would silently mis-grade every property company rather than
 * failing loudly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isREIT, buildScore } from '../lib/score.js';

describe('isREIT', () => {
  test('recognises the industries Yahoo files REITs under', () => {
    for (const industry of ['REIT - Retail', 'REIT - Industrial', 'REIT—Specialty', 'reit - office']) {
      assert.equal(isREIT({ industry }), true, industry);
    }
  });

  test('does not catch real-estate businesses that are not REITs', () => {
    // CBRE is a real-estate services firm and must be scored on earnings.
    for (const industry of ['Real Estate Services', 'Real Estate - Development', 'Railroads', '']) {
      assert.equal(isREIT({ industry }), false, industry);
    }
    assert.equal(isREIT({}), false);
  });
});

/** Minimal but realistic inputs: a profitable company with a covered dividend. */
function fixture({ industry = 'Railroads', ...overrides } = {}) {
  const year = (date, extra = {}) => ({
    date,
    totalRevenue: 1000,
    netIncome: 200,
    dilutedEPS: 2,
    operatingIncome: 300,
    ebitda: 400,
    ebit: 300,
    depreciationAndAmortization: 100,
    freeCashFlow: 150,
    operatingCashFlow: 250,
    cashDividendsPaid: -60,
    totalDebt: 800,
    cashAndCashEquivalents: 100,
    totalAssets: 3000,
    interestExpense: 40,
    dilutedAverageShares: 100,
    ...extra,
  });

  return {
    summary: {
      summaryProfile: { industry },
      price: { marketCap: 6000, regularMarketPrice: 60 },
      summaryDetail: { trailingPE: 30, dividendYield: 0.02, fiveYearAvgDividendYield: 2 },
      financialData: { returnOnEquity: 0.2 },
      defaultKeyStatistics: {},
      ...overrides.summary,
    },
    financials: [year('2022-12-31'), year('2023-12-31'), year('2024-12-31'), year('2025-12-31')],
    dividendPayments: Array.from({ length: 20 }, (_, i) => ({
      t: Date.UTC(2021, i * 3, 1),
      amount: 0.5 + i * 0.01,
    })),
  };
}

describe('buildScore', () => {
  test('scores an operating company on the standard basis', () => {
    const score = buildScore(fixture());
    assert.equal(score.basis, 'standard');
    assert.ok(score.overall > 0 && score.overall <= 100);
    assert.equal(score.pillars.length, 5);
    assert.ok(score.keyFigures.some((f) => f.label === 'P / E (TTM)'));
  });

  test('scores a REIT on the REIT basis, reporting FFO rather than EPS', () => {
    const score = buildScore(fixture({ industry: 'REIT - Retail' }));
    assert.equal(score.basis, 'reit');
    const labels = score.keyFigures.map((f) => f.label);
    assert.ok(labels.includes('P / FFO'), 'REITs are priced on P/FFO');
    assert.ok(!labels.includes('P / E (TTM)'), 'a REIT P/E is not comparable and must not headline');
  });

  test('the basis changes the grade for identical financials', () => {
    // The whole thesis in one assertion: the same numbers do not score the same
    // through the two lenses, because the REIT branch measures cash where the
    // standard branch measures earnings. Direction is not asserted — it depends
    // on the thresholds, and pinning it here would make this a change-detector
    // rather than a test.
    const standard = buildScore(fixture({ industry: 'Railroads' }));
    const reit = buildScore(fixture({ industry: 'REIT - Retail' }));
    assert.notEqual(standard.overall, reit.overall);
  });

  test('a REIT is judged on EBITDA interest coverage, not EBIT', () => {
    // EBIT charges a REIT for depreciation it never funds. With D&A of 100 the
    // two differ by a quarter, and only the EBITDA reading is meaningful.
    const reit = buildScore(fixture({ industry: 'REIT - Retail' }));
    const balance = reit.pillars.find((p) => p.title === 'Balance sheet');
    const coverage = balance.metrics.find((m) => m.label === 'Interest coverage');
    assert.equal(coverage.display, '10.0×'); // ebitda 400 / interest 40
  });

  test('a token dividend is not graded', () => {
    // NVIDIA's yield is a rounding error; grading it would let a meaningless
    // number carry a quarter of the score.
    const f = fixture();
    f.summary.summaryDetail.dividendYield = 0.0002;
    f.financials = f.financials.map((y) => ({ ...y, cashDividendsPaid: -0.5 }));
    const score = buildScore(f);
    const dividend = score.pillars.find((p) => p.title === 'Dividend safety');
    assert.equal(dividend.score, null);
    assert.ok(score.coverage < 100, 'the dropped pillar should reduce coverage');
  });

  test('missing statements produce no score rather than a confident wrong one', () => {
    const score = buildScore({ summary: { summaryProfile: {} }, financials: [], dividendPayments: [] });
    assert.equal(score.overall, null);
    assert.equal(score.grade, null);
  });

  test('the grade always matches the score it is shown beside', () => {
    // The bug this catches: grading the unrounded score while displaying the
    // rounded one, so 72.6 printed as "73" and graded as B.
    const ladder = [
      [88, 'A+'], [80, 'A'], [73, 'B+'], [66, 'B'], [58, 'C+'], [50, 'C'], [40, 'D'],
    ];
    for (const industry of ['Railroads', 'REIT - Retail']) {
      const score = buildScore(fixture({ industry }));
      if (score.overall == null) continue;
      const expected = ladder.find(([floor]) => score.overall >= floor)?.[1] ?? 'F';
      assert.equal(score.grade, expected, `${industry}: ${score.overall} should grade ${expected}`);
    }
  });
});
