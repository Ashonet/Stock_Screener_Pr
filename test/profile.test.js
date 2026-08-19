/**
 * Tests for the profile builder's fallback behaviour.
 *
 * These exist because of one specific failure: when the session-gated summary
 * is unavailable the day's move is derived from the price chart, and doing that
 * without regard for the chart's range reported NVIDIA as up 511,286% today.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildProfile, quoteFromChart } from '../lib/profile.js';

/** A chart as getChart() returns it. */
function chart({ range, interval, points, previousClose }) {
  return {
    symbol: 'NVDA',
    name: 'NVIDIA Corporation',
    currency: 'USD',
    range,
    interval,
    previousClose,
    price: points.at(-1).c,
    points,
  };
}

const bars = (closes) => closes.map((c, i) => ({ t: Date.UTC(2026, 0, 1) + i * 86_400_000, c }));

describe('buildProfile day change when the summary is unavailable', () => {
  test('uses the chart previous close on the intraday range', () => {
    // On a 1-day chart, chartPreviousClose really is yesterday.
    const { quote } = buildProfile('NVDA', {}, chart({ range: '1d', interval: '5m', previousClose: 226, points: bars([225]) }));
    assert.equal(quote.previousClose, 226);
    assert.equal(quote.change, -1);
  });

  test('uses the second-to-last bar when the bars are daily', () => {
    const { quote } = buildProfile(
      'NVDA',
      {},
      chart({ range: '1y', interval: '1d', previousClose: 150, points: bars([220, 226, 225]) }),
    );
    // Not 150. That is the close before the whole year, not yesterday.
    assert.equal(quote.previousClose, 226);
    assert.equal(quote.change, -1);
  });

  test('reports nothing on the MAX range rather than a decades-old close', () => {
    // The actual bug: monthly bars back to 1999, chartPreviousClose = $0.044.
    // Using it printed "+511,286.36% today".
    const { quote } = buildProfile(
      'NVDA',
      {},
      chart({ range: 'max', interval: '1mo', previousClose: 0.044, points: bars([0.05, 100, 225]) }),
    );
    assert.equal(quote.previousClose, null);
    assert.equal(quote.change, null);
    assert.equal(quote.changePercent, null);
  });

  test('reports nothing on weekly bars either', () => {
    const { quote } = buildProfile(
      'NVDA',
      {},
      chart({ range: '5y', interval: '1wk', previousClose: 12, points: bars([50, 210, 225]) }),
    );
    assert.equal(quote.previousClose, null);
    assert.equal(quote.change, null);
  });

  test('the real summary always wins over any chart fallback', () => {
    const summary = {
      price: { regularMarketPreviousClose: { raw: 225.16 }, regularMarketPrice: { raw: 225.01 } },
      summaryProfile: {},
      summaryDetail: {},
      financialData: {},
      defaultKeyStatistics: {},
    };
    const { quote } = buildProfile(
      'NVDA',
      summary,
      chart({ range: 'max', interval: '1mo', previousClose: 0.044, points: bars([0.05, 225.01]) }),
    );
    assert.equal(quote.previousClose, 225.16);
    assert.ok(Math.abs(quote.change + 0.15) < 1e-6);
  });

  test('a chart with a single bar cannot invent a previous close', () => {
    const { quote } = buildProfile('NVDA', {}, chart({ range: '1y', interval: '1d', previousClose: 1, points: bars([225]) }));
    assert.equal(quote.previousClose, null);
  });
});

describe('quoteFromChart, the wallet fallback', () => {
  test('the stored close answers whatever range the chart is showing', () => {
    // The point of the whole exercise: a day change is a fact about yesterday,
    // not about the chart. With a stored close it is the same on MAX as on 1D,
    // where deriving it from the chart gave +541,057% and then nothing.
    const maxChart = chart({ range: 'max', interval: '1mo', previousClose: 0.089, points: bars([0.1, 120, 481.63]) });
    const dayChart = chart({ range: '1d', interval: '5m', previousClose: 480.35, points: bars([481.63]) });
    const stored = { prev_close: 480.35, trade_date: '2026-08-18' };

    const onMax = quoteFromChart(maxChart, stored);
    const onDay = quoteFromChart(dayChart, stored);

    assert.equal(onMax.previousClose, 480.35);
    assert.ok(Math.abs(onMax.changePercent - onDay.changePercent) < 1e-9, 'same answer on both ranges');
    assert.ok(Math.abs(onMax.changePercent - 0.2665) < 0.01, `got ${onMax.changePercent}`);
    assert.equal(onMax.previousCloseAsOf, '2026-08-18', 'and it says how fresh the comparison is');
  });

  test('the stored close beats the chart even where the chart has one', () => {
    // A daily chart can supply yesterday, but the warehouse is the same fact
    // from the source that is not range-dependent, so it wins for consistency.
    const quote = quoteFromChart(
      chart({ range: '1y', interval: '1d', previousClose: 150, points: bars([220, 226, 225]) }),
      { prev_close: 224, trade_date: '2026-08-18' },
    );
    assert.equal(quote.previousClose, 224);
  });

  test('a MAX chart yields no day change rather than a five-figure one', () => {
    // The reported bug: the holdings table read "+541,057.30%" for Microsoft on
    // the MAX range, because the fallback compared today's price against the
    // close before the whole range, which for MSFT is the 1980s.
    const quote = quoteFromChart(
      chart({ range: 'max', interval: '1mo', previousClose: 0.089, points: bars([0.1, 120, 481.63]) }),
    );

    assert.equal(quote.previousClose, null);
    assert.equal(quote.change, null);
    assert.equal(quote.changePercent, null);
  });

  test('a daily chart uses yesterday, so the day change is a day', () => {
    const quote = quoteFromChart(
      chart({ range: '1y', interval: '1d', previousClose: 150, points: bars([220, 226, 225]) }),
    );

    assert.equal(quote.previousClose, 226);
    assert.equal(quote.change, -1);
    assert.ok(Math.abs(quote.changePercent + 0.442) < 0.01);
  });

  test('an intraday chart uses the real previous close', () => {
    const quote = quoteFromChart(chart({ range: '1d', interval: '5m', previousClose: 226, points: bars([225]) }));
    assert.equal(quote.previousClose, 226);
    assert.equal(quote.change, -1);
  });

  test('the symbol and currency are carried through for the table', () => {
    const quote = quoteFromChart(chart({ range: '1d', interval: '5m', previousClose: 100, points: bars([101]) }));
    assert.equal(quote.symbol, 'NVDA');
    assert.equal(quote.currency, 'USD');
    assert.equal(quote.price, 101);
  });

  test('an untracked symbol still falls back to the chart, range-aware', () => {
    // Nothing stored, so the old behaviour applies: yesterday on a daily chart,
    // nothing on a monthly one.
    const daily = quoteFromChart(chart({ range: '1y', interval: '1d', previousClose: 1, points: bars([10, 11]) }), null);
    const monthly = quoteFromChart(chart({ range: 'max', interval: '1mo', previousClose: 0.01, points: bars([1, 11]) }), null);

    assert.equal(daily.previousClose, 10);
    assert.equal(monthly.previousClose, null);
    assert.equal(monthly.previousCloseAsOf, null);
  });

  test('no chart yields no quote', () => {
    assert.equal(quoteFromChart(null), null);
  });
});
