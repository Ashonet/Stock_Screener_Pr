/**
 * Tests for the profile builder's fallback behaviour.
 *
 * These exist because of one specific failure: when the session-gated summary
 * is unavailable the day's move is derived from the price chart, and doing that
 * without regard for the chart's range reported NVIDIA as up 511,286% today.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildProfile } from '../lib/profile.js';

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
