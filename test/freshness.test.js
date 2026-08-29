/**
 * Tests for the stored-data freshness label.
 *
 * The bug these exist to prevent was not a crash or a wrong format. It was a
 * plausible date drawn from the wrong column: the last trade date standing in
 * for an ingest time, so a profile fetched that morning was labelled three days
 * old. Nothing failed, and the only symptom was a number that looked slightly
 * wrong to someone who knew when the pipeline had run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { storedAsOf } from '../lib/freshness.js';

const stored = {
  asOf: '2026-08-29 14:54:38.324',
  financialsAsOf: '2026-08-29 14:54:38.324',
  // Deliberately present, deliberately never chosen.
  priceAsOf: '2026-08-27',
};

describe('storedAsOf', () => {
  test('dates fundamentals by when they were stored', () => {
    const result = storedAsOf(['fundamentals'], stored);
    assert.match(result, /^2026-08-29/);
  });

  test('never reaches for the price date', () => {
    // The original bug. A trade date is not an ingest time, and the banner it
    // appears in says prices are current in the same sentence.
    const result = storedAsOf(['fundamentals'], { ...stored, asOf: '2026-08-29 09:00:00' });
    assert.ok(!result.startsWith('2026-08-27'), 'the 27th is the last close, not an ingest');
  });

  test('takes the most recent of several served kinds', () => {
    const result = storedAsOf(['fundamentals', 'financials'], {
      asOf: '2026-08-29 14:00:00',
      financialsAsOf: '2026-08-17 19:00:00',
    });
    assert.match(result, /^2026-08-29/, 'the banner covers both, so the oldest must not speak for both');
  });

  test('ignores the timestamp of a kind that was not served', () => {
    const result = storedAsOf(['financials'], {
      asOf: '2026-08-29 14:00:00',
      financialsAsOf: '2026-08-17 19:00:00',
    });
    assert.match(result, /^2026-08-17/, 'fundamentals were live, so their ingest is irrelevant');
  });

  test('nothing served means no date rather than a fabricated one', () => {
    assert.equal(storedAsOf([], stored), null);
  });

  test('an unusable timestamp yields no date rather than Invalid Date', () => {
    assert.equal(storedAsOf(['fundamentals'], { asOf: 'not a date' }), null);
    assert.equal(storedAsOf(['fundamentals'], { asOf: null }), null);
  });

  test('survives being called with nothing', () => {
    assert.equal(storedAsOf(), null);
  });
});
