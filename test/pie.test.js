/**
 * Tests for donut layout and facet grouping.
 *
 * The geometry has two traps: a single slice is a full turn, which cannot be
 * drawn as one arc because its ends coincide, and a negative value has no angle
 * at all and would silently invert everything drawn after it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sliceLayout, groupByFacet, arcPath, pointOnCircle } from '../public/js/pie.js';

const TAU = Math.PI * 2;
const value = (label, v, extra = {}) => ({ label, value: v, ...extra });

describe('sliceLayout', () => {
  test('shares and angles are proportional, largest first', () => {
    const { slices, total } = sliceLayout([value('a', 25), value('b', 50), value('c', 25)]);

    assert.equal(total, 100);
    assert.deepEqual(
      slices.map((s) => s.label),
      ['b', 'a', 'c'],
      'sorted so the reader does not hunt for the biggest',
    );
    assert.equal(slices[0].share, 50);
    assert.ok(Math.abs(slices[0].endAngle - slices[0].startAngle - Math.PI) < 1e-9);
  });

  test('slices tile the circle exactly, with no gap and no overlap', () => {
    const { slices } = sliceLayout([value('a', 1), value('b', 2), value('c', 7)]);

    assert.equal(slices[0].startAngle, 0);
    assert.ok(Math.abs(slices.at(-1).endAngle - TAU) < 1e-9);
    for (let i = 1; i < slices.length; i++) {
      assert.ok(Math.abs(slices[i].startAngle - slices[i - 1].endAngle) < 1e-12, 'no seam between slices');
    }
    assert.ok(Math.abs(slices.reduce((sum, s) => sum + s.share, 0) - 100) < 1e-9);
  });

  test('zero and negative values are dropped rather than drawn', () => {
    // A negative slice has no angle. Drawing it would run the sweep backwards
    // and every slice after it would land in the wrong place.
    const { slices, total, dropped } = sliceLayout([value('a', 10), value('b', -5), value('c', 0)]);

    assert.equal(slices.length, 1);
    assert.equal(total, 10);
    assert.equal(dropped, 2);
    assert.equal(slices[0].share, 100);
  });

  test('nothing usable yields nothing rather than dividing by zero', () => {
    const empty = sliceLayout([]);
    assert.deepEqual(empty.slices, []);
    assert.equal(empty.total, 0);
    assert.deepEqual(sliceLayout([value('a', 0)]).slices, []);
  });
});

describe('arcPath', () => {
  test('a lone slice is drawn as two arcs, not one', () => {
    // A full turn's start and end points coincide, so a single arc command is
    // ambiguous between a whole circle and nothing at all.
    const path = arcPath(50, 50, 40, 24, 0, TAU);
    assert.equal((path.match(/A/g) ?? []).length, 4, 'two segments, two arcs each');
    assert.ok(path.startsWith('M'));
  });

  test('the large-arc flag flips past a half turn', () => {
    const small = arcPath(50, 50, 40, 24, 0, Math.PI / 2);
    const large = arcPath(50, 50, 40, 24, 0, Math.PI * 1.5);
    assert.ok(small.includes('0 1'), 'quarter turn is not a large arc');
    assert.ok(large.includes('1 1'), 'three-quarter turn is');
  });

  test('an empty sweep draws nothing', () => {
    assert.equal(arcPath(50, 50, 40, 24, 1, 1), '');
    assert.equal(arcPath(50, 50, 40, 24, 2, 1), '');
  });

  test('angles start at twelve o\'clock and run clockwise', () => {
    const top = pointOnCircle(0, 0, 10, 0);
    const right = pointOnCircle(0, 0, 10, Math.PI / 2);

    assert.ok(Math.abs(top.x) < 1e-9 && Math.abs(top.y + 10) < 1e-9, 'zero is straight up');
    assert.ok(Math.abs(right.x - 10) < 1e-9 && Math.abs(right.y) < 1e-9, 'a quarter turn is to the right');
  });
});

describe('groupByFacet', () => {
  const rows = [
    { symbol: 'O', value: 100, sector: 'Real Estate' },
    { symbol: 'VICI', value: 50, sector: 'Real Estate' },
    { symbol: 'KO', value: 80, sector: 'Consumer Defensive' },
    { symbol: 'NVDA', value: 20, sector: null },
  ];

  test('sums by facet, largest first', () => {
    const groups = groupByFacet(rows, 'sector');
    assert.deepEqual(
      groups.map((g) => [g.label, g.value]),
      [
        ['Real Estate', 150],
        ['Consumer Defensive', 80],
        ['Unclassified', 20],
      ],
    );
  });

  test('a missing facet is named, not dropped', () => {
    // Dropping it would make the shares add up to less than the portfolio,
    // which reads as a rounding bug rather than as missing reference data.
    const groups = groupByFacet(rows, 'sector');
    const total = groups.reduce((sum, g) => sum + g.value, 0);
    assert.equal(total, 250, 'every priced holding is represented');
  });

  test('the tail folds into one slice once the palette runs out', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ value: 12 - i, sector: `S${i}` }));
    const groups = groupByFacet(many, 'sector', { maxSlices: 6 });

    assert.equal(groups.length, 6, 'the fold takes a slot rather than adding one');
    assert.equal(groups.at(-1).label, 'Other');
    assert.equal(groups.at(-1).folded, 7);
    // Nothing is lost: Other carries the value and the names behind it.
    assert.equal(
      groups.reduce((sum, g) => sum + g.value, 0),
      many.reduce((sum, r) => sum + r.value, 0),
    );
    assert.equal(groups.at(-1).members.length, 7);
  });

  test('no fold when everything fits', () => {
    const groups = groupByFacet(rows, 'sector', { maxSlices: 6 });
    assert.ok(groups.every((g) => g.folded === undefined));
  });

  test('members are kept so the table can list what Other contains', () => {
    const groups = groupByFacet(rows, 'sector');
    const realEstate = groups.find((g) => g.label === 'Real Estate');
    assert.deepEqual(realEstate.members.map((m) => m.symbol), ['O', 'VICI']);
  });
});
