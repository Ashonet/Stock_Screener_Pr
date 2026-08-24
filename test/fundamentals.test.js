/**
 * Tests for the fundamentals chart set.
 *
 * The one that matters is the branch. A REIT charted like an operating company
 * shows a business in trouble when nothing is wrong: depreciation on property
 * that is holding its value pushes reported earnings far below the cash
 * produced, so EPS and net income both misread. The REIT set leads with FFO and
 * cash flow and leaves EPS out entirely.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fundamentalCharts } from '../public/js/fundamentals.js';

/** A statement row with the fields both bases draw on. */
const row = (date, over = {}) => ({
  date,
  totalRevenue: 1000,
  netIncome: 100,
  depreciationAndAmortization: 300,
  dilutedEPS: 0.1,
  dilutedAverageShares: 1000,
  operatingIncome: 200,
  operatingCashFlow: 420,
  freeCashFlow: 380,
  capitalExpenditure: -40,
  totalDebt: 2000,
  cashAndCashEquivalents: 200,
  stockholdersEquity: 5000,
  totalAssets: 9000,
  cashDividendsPaid: -250,
  ebitda: 500,
  ebit: 200,
  interestExpense: 50,
  ...over,
});

const years = ['2022-12-31', '2023-12-31', '2024-12-31'].map((d) => row(d));
const keys = (result) => result.charts.map((c) => c.key);

describe('fundamentalCharts, REIT basis', () => {
  const result = fundamentalCharts(years, 'reit');

  test('leads with FFO and never charts EPS', () => {
    assert.equal(keys(result)[0], 'ffo');
    assert.ok(keys(result).includes('ffoPerShare'));
    assert.ok(!keys(result).includes('eps'), 'EPS misreads a REIT and is left out');
    assert.ok(!keys(result).includes('netIncome'));
  });

  test('FFO is net income plus depreciation', () => {
    const ffo = result.charts.find((c) => c.key === 'ffo');
    assert.deepEqual(ffo.values, [400, 400, 400]);
  });

  test('FFO per share divides by the share count', () => {
    const perShare = result.charts.find((c) => c.key === 'ffoPerShare');
    assert.deepEqual(perShare.values, [0.4, 0.4, 0.4]);
  });

  test('payout is measured against cash flow, not earnings', () => {
    // 250 of dividends against 420 of operating cash flow is 60%. Against 100
    // of net income it would read 250% and look like a company in distress.
    const payout = result.charts.find((c) => c.key === 'payout');
    assert.ok(Math.abs(payout.values[0] - 59.52) < 0.01, `got ${payout.values[0]}`);
    assert.match(payout.title, /operating cash flow/i);
  });

  test('interest coverage is measured before depreciation', () => {
    // EBITDA 500 over interest 50 is 10x. EBIT would give 4x and charge the
    // REIT for a non-cash cost it never funds.
    const cover = result.charts.find((c) => c.key === 'interestCoverage');
    assert.equal(cover.values[0], 10);
    assert.match(cover.title, /EBITDA/);
  });

  test('the metrics this data cannot supply are named', () => {
    // Occupancy lives in supplementals, not in the financial statements. A
    // reader looking for it should be told it is unobtainable here rather than
    // left to conclude the company does not report it.
    assert.ok(result.unavailable.includes('Occupancy'));
    assert.ok(result.unavailable.length >= 3);
  });
});

describe('fundamentalCharts, operating company basis', () => {
  const result = fundamentalCharts(years, 'standard');

  test('leads with earnings and charts EPS and book value', () => {
    assert.equal(keys(result)[0], 'netIncome');
    for (const key of ['eps', 'bookValue', 'bookValuePerShare', 'netMargin', 'returnOnEquity']) {
      assert.ok(keys(result).includes(key), key);
    }
  });

  test('no FFO, which is a REIT construction', () => {
    assert.ok(!keys(result).includes('ffo'));
    assert.ok(!keys(result).includes('ffoPerShare'));
  });

  test('interest coverage is measured on EBIT', () => {
    const cover = result.charts.find((c) => c.key === 'interestCoverage');
    assert.equal(cover.values[0], 4);
    assert.match(cover.title, /EBIT\)/);
  });

  test('payout is measured against free cash flow', () => {
    const payout = result.charts.find((c) => c.key === 'payout');
    assert.ok(Math.abs(payout.values[0] - 65.79) < 0.01, `got ${payout.values[0]}`);
  });

  test('nothing is listed as unavailable', () => {
    assert.deepEqual(result.unavailable, []);
  });
});

describe('what both bases share', () => {
  test('debt to assets and the share count are on every company', () => {
    for (const basis of ['reit', 'standard']) {
      const result = fundamentalCharts(years, basis);
      assert.ok(keys(result).includes('debtToAssets'), basis);
      assert.ok(keys(result).includes('shares'), basis);
      assert.ok(keys(result).includes('revenue'), basis);
    }
  });

  test('net debt is debt less cash, not gross debt', () => {
    const result = fundamentalCharts(years, 'standard');
    const leverage = result.charts.find((c) => c.key === 'netDebtToEbitda');
    // (2000 - 200) / 500 = 3.6, where gross debt would read 4.0.
    assert.equal(leverage.values[0], 3.6);
  });
});

describe('missing data', () => {
  test('a series with no values anywhere is dropped, not drawn empty', () => {
    // Some REITs have no capex line, so free cash flow is absent for every
    // period. An empty chart frame says less than no chart at all.
    const noFcf = years.map((y) => ({ ...y, freeCashFlow: null, capitalExpenditure: null }));
    const result = fundamentalCharts(noFcf, 'reit');
    assert.ok(!keys(result).includes('freeCashFlow'));
  });

  test('a series with a gap is kept, with the gap intact', () => {
    const gappy = [row('2022-12-31', { netIncome: null }), row('2023-12-31'), row('2024-12-31')];
    const result = fundamentalCharts(gappy, 'standard');
    const earnings = result.charts.find((c) => c.key === 'netIncome');

    assert.equal(earnings.values[0], null, 'the gap survives rather than being filled');
    assert.equal(earnings.values[1], 100);
  });

  test('every chart carries its periods, aligned with its values', () => {
    const result = fundamentalCharts(years, 'reit');
    for (const chart of result.charts) {
      assert.equal(chart.values.length, chart.periods.length, chart.key);
      assert.deepEqual(chart.periods, ['2022-12-31', '2023-12-31', '2024-12-31']);
    }
  });

  test('no rows yields no charts rather than throwing', () => {
    assert.deepEqual(fundamentalCharts([], 'reit').charts, []);
    assert.deepEqual(fundamentalCharts(undefined, 'standard').charts, []);
    assert.deepEqual(fundamentalCharts([{ notADate: 1 }], 'reit').charts, []);
  });
});
