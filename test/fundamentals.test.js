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

  test('AFFO is drawn as a band, never as a single figure', () => {
    // The feed carries one capex line covering maintenance and growth together,
    // and nothing separates them. Subtracting the whole line calls all growth
    // spending maintenance; subtracting none of it ignores capex entirely. The
    // truth is between, so both are drawn and neither is called AFFO alone.
    const affo = result.charts.find((c) => c.key === 'affo');

    assert.ok(affo.series, 'a band, not a single series');
    assert.equal(affo.series.length, 2);
    // FFO 400 less capex 40 is the floor; operating cash flow 420 is the ceiling.
    assert.deepEqual(affo.series[0].values, [360, 360, 360]);
    assert.deepEqual(affo.series[1].values, [420, 420, 420]);
    // Which reads higher is not fixed: VICI's FFO less capex sits above its
    // operating cash flow because working capital moved against it. The pair
    // brackets the answer in the usual case, not in every case.
    assert.equal(affo.series[0].name, 'FFO less capex');
    assert.equal(affo.series[1].name, 'Operating cash flow');
  });

  test('payout is measured against cash flow, not earnings, on both bounds', () => {
    // 250 of dividends against 420 of operating cash flow is 60%. Against 100
    // of net income it would read 250% and look like a company in distress.
    const payout = result.charts.find((c) => c.key === 'affoPayout');
    assert.ok(Math.abs(payout.series[1].values[0] - 59.52) < 0.01, `got ${payout.series[1].values[0]}`);
    assert.ok(payout.series[0].values[0] > payout.series[1].values[0], 'subtracting capex raises the payout');
  });

  test('a REIT that builds does not get a negative AFFO presented as fact', () => {
    // Equinix spends more on capex than it earns in FFO. The floor goes
    // negative, which is a statement about growth spending rather than about
    // the dividend, and it is only ever shown beside the ceiling.
    const builder = years.map((y) => ({ ...y, capitalExpenditure: -500 }));
    const built = fundamentalCharts(builder, 'reit');
    const affo = built.charts.find((c) => c.key === 'affo');

    assert.ok(affo.series[0].values[0] < 0, 'subtracting all capex can go negative');
    assert.ok(affo.series[1].values[0] > 0, 'and is never shown without the other estimate');
    assert.equal(affo.series.length, 2);
  });

  test('a REIT with no capex line still gets the ceiling', () => {
    const noCapex = years.map((y) => ({ ...y, capitalExpenditure: null }));
    const result2 = fundamentalCharts(noCapex, 'reit');
    const affo = result2.charts.find((c) => c.key === 'affo');

    assert.equal(affo.series.length, 1, 'only the estimate that exists');
    assert.equal(result2.affoBounded, false, 'and the card is told there is no range');
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
    // Two shapes: a single series carries `values`, a band carries `series`.
    // Either way one value per period, or the bars land against the wrong year.
    for (const basis of ['reit', 'standard']) {
      for (const chart of fundamentalCharts(years, basis).charts) {
        const lanes = chart.series ? chart.series.map((s) => s.values) : [chart.values];
        for (const values of lanes) {
          assert.equal(values.length, chart.periods.length, `${basis}/${chart.key}`);
        }
        assert.deepEqual(chart.periods, ['2022-12-31', '2023-12-31', '2024-12-31']);
      }
    }
  });

  test('no rows yields no charts rather than throwing', () => {
    assert.deepEqual(fundamentalCharts([], 'reit').charts, []);
    assert.deepEqual(fundamentalCharts(undefined, 'standard').charts, []);
    assert.deepEqual(fundamentalCharts([{ notADate: 1 }], 'reit').charts, []);
  });
});
