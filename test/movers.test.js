/**
 * Tests for the score movers range picker.
 *
 * The two that matter are both about not inventing movement. Scores are written
 * when the pipeline runs rather than daily, so the snapshot a range asks for
 * usually does not exist and the view has to say which one it really used; and
 * the universe grew from 505 companies to 1,973 mid-record, so a missing prior
 * score means "was not covered yet", never "leapt to an A overnight".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  comparisonSnapshot,
  splitMovers,
  isValidMoverRange,
  pickBasis,
  moversFromPairs,
  MOVER_RANGES,
} from '../lib/movers.js';

/** The real shape of the record: irregular, with gaps over weekends. */
const snapshots = [
  '2026-08-18',
  '2026-08-19',
  '2026-08-20',
  '2026-08-21',
  '2026-08-24',
  '2026-08-29',
  '2026-09-01',
  '2026-09-02',
];

describe('comparisonSnapshot', () => {
  test('1d compares against the previous snapshot', () => {
    const c = comparisonSnapshot(snapshots, '1d');
    assert.equal(c.to, '2026-09-02');
    assert.equal(c.from, '2026-09-01');
    assert.equal(c.gapDays, 1);
  });

  test('lands on the nearest snapshot on or before the cutoff, and says so', () => {
    // 5 days back from the 2nd is the 28th, and nothing was written that day.
    const c = comparisonSnapshot(snapshots, '5d');
    assert.equal(c.requested, '2026-08-28');
    assert.equal(c.from, '2026-08-24', 'the 24th is the nearest on or before');
    assert.equal(c.exact, false, 'the view has to be able to say this was not exact');
    assert.equal(c.gapDays, 9, 'and that the real gap was nine days, not five');
  });

  test('never reaches forward for a closer snapshot', () => {
    /*
     * The 29th is nearer to the 28th cutoff than the 24th is. Taking it would
     * report four days of movement under a heading that says five, understating
     * the period in the direction that flatters recent movement.
     */
    const c = comparisonSnapshot(snapshots, '5d');
    assert.ok(c.from < c.requested, 'must be on or before, even when a later one is nearer');
  });

  test('reports that nothing is old enough rather than returning something wrong', () => {
    for (const key of ['1m', '3m', '6m', '1y', '3y']) {
      const c = comparisonSnapshot(snapshots, key);
      assert.equal(c.from, null, `${key} has no snapshot behind it yet`);
      assert.equal(c.oldest, '2026-08-18', 'and the view needs to say how far back the record goes');
    }
  });

  test('every offered range resolves rather than throwing', () => {
    for (const range of MOVER_RANGES) {
      assert.ok(comparisonSnapshot(snapshots, range.key), `${range.key} returned nothing`);
      assert.ok(isValidMoverRange(range.key));
    }
    assert.equal(isValidMoverRange('7q'), false);
  });

  test('survives an empty or unusable record', () => {
    assert.equal(comparisonSnapshot([], '1d'), null);
    assert.equal(comparisonSnapshot(snapshots, 'nonsense'), null);
    assert.equal(comparisonSnapshot(['not a date'], '1d'), null);
  });

  test('accepts Date objects as well as strings, since DuckDB returns both', () => {
    const c = comparisonSnapshot([new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z')], '1d');
    assert.equal(c.to, '2026-09-02');
    assert.equal(c.from, '2026-09-01');
  });
});

describe('splitMovers', () => {
  const rows = [
    { symbol: 'UP', score: 80, previousScore: 70, change: 10, gradeChanged: true },
    { symbol: 'DOWN', score: 60, previousScore: 75, change: -15, gradeChanged: true },
    { symbol: 'NUDGE', score: 71, previousScore: 70, change: 1, gradeChanged: false },
    { symbol: 'FLAT', score: 90, previousScore: 90, change: 0, gradeChanged: false },
    { symbol: 'NEW', score: 95, previousScore: null, change: null, gradeChanged: false },
  ];

  test('a company that was not scored before has not moved', () => {
    /*
     * The universe went from 505 names to 1,972 in one run. Counting a first
     * score as a change would have announced 1,467 companies as having leapt to
     * an A, which is the single most misleading thing this view could do.
     */
    const s = splitMovers(rows);
    assert.deepEqual(s.newlyCovered.map((r) => r.symbol), ['NEW']);
    assert.ok(!s.movers.some((r) => r.symbol === 'NEW'), 'a new company is not a mover');
  });

  test('ranks by the size of the move, not its direction', () => {
    const s = splitMovers(rows);
    assert.deepEqual(s.movers.map((r) => r.symbol), ['DOWN', 'UP', 'NUDGE']);
  });

  test('counts the unchanged rather than listing them', () => {
    const s = splitMovers(rows);
    assert.equal(s.unchanged, 1, 'FLAT was scored on both dates and did not move');
    assert.equal(s.up, 2);
    assert.equal(s.down, 1);
    assert.equal(s.regraded, 2);
  });

  test('survives being called with nothing', () => {
    const s = splitMovers();
    assert.deepEqual(s.movers, []);
    assert.equal(s.unchanged, 0);
  });
});

describe('pickBasis', () => {
  const quarterlyFrom = '2024-12-31';
  const annualFrom = '2021-10-31';

  test('a recorded snapshot beats a reconstruction of one', () => {
    const b = pickBasis({ rangeKey: '1d', snapshots, quarterlyFrom, annualFrom });
    assert.equal(b.basis, 'recorded');
  });

  test('falls to quarterly statements when no snapshot reaches', () => {
    /*
     * And quarterly rather than annual, because an annual score steps once a
     * year: over three months it finds a few dozen movers where quarterly finds
     * over a thousand.
     */
    const b = pickBasis({ rangeKey: '3m', snapshots, quarterlyFrom, annualFrom });
    assert.equal(b.basis, 'reconstructed');
    assert.equal(b.periodType, 'quarterly');
  });

  test('falls to annual only when quarterly cannot reach that far back', () => {
    const b = pickBasis({ rangeKey: '3y', snapshots, quarterlyFrom, annualFrom });
    assert.equal(b.periodType, 'annual', 'quarterly statements start in 2024');
  });

  test('reports that nothing reaches rather than inventing a comparison', () => {
    const b = pickBasis({ rangeKey: '3y', snapshots, quarterlyFrom, annualFrom: '2025-01-01' });
    assert.equal(b.basis, 'none');
    assert.equal(b.earliest, '2024-12-31', 'and says how far back anything reaches');
  });
});

describe('moversFromPairs', () => {
  const meta = new Map([['UP', { name: 'Upward', sector: 'Tech' }]]);
  const pairs = [
    { symbol: 'UP', now: { score: 80, grade: 'A', period: '2026-06-30' }, was: { score: 60, grade: 'C', period: '2025-06-30' } },
    { symbol: 'FLAT', now: { score: 70, grade: 'B', period: '2026-06-30' }, was: { score: 70, grade: 'B', period: '2026-06-30' } },
    { symbol: 'NEW', now: { score: 90, grade: 'A', period: '2026-06-30' }, was: null },
    { symbol: 'GONE', now: null, was: { score: 50, grade: 'D', period: '2025-06-30' } },
  ];

  test('subtracts the two point-in-time scores', () => {
    const rows = moversFromPairs(pairs, meta);
    const up = rows.find((r) => r.symbol === 'UP');
    assert.equal(up.previousScore, 60);
    assert.equal(up.score, 80);
    assert.equal(up.change, 20);
    assert.equal(up.gradeChanged, true);
    assert.equal(up.name, 'Upward');
  });

  test('a company priced at only the newer end is newly covered, not a mover', () => {
    const rows = moversFromPairs(pairs, meta);
    const fresh = rows.find((r) => r.symbol === 'NEW');
    assert.equal(fresh.previousScore, null);
    assert.equal(fresh.change, null);
    assert.ok(splitMovers(rows).newlyCovered.some((r) => r.symbol === 'NEW'));
  });

  test('a company with no score at the newer end is left out entirely', () => {
    // Nothing to report about a company that cannot be scored today, and a row
    // of dashes is worse than an absent row.
    const rows = moversFromPairs(pairs, meta);
    assert.ok(!rows.some((r) => r.symbol === 'GONE'));
  });

  test('says which statements each end rested on', () => {
    const rows = moversFromPairs(pairs, meta);
    const up = rows.find((r) => r.symbol === 'UP');
    assert.equal(up.previousPeriod, '2025-06-30');
    assert.equal(up.asOfPeriod, '2026-06-30');
  });

  test('survives being called with nothing', () => {
    assert.deepEqual(moversFromPairs(), []);
  });
});
