/**
 * Geometry tests for the squarified treemap.
 *
 * A treemap that leaks tiles outside its rectangle, overlaps them, or loses
 * area is lying about the values it encodes, and none of that is obvious by
 * looking at it, which is exactly why it is worth asserting.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { squarify } from '../public/js/treemap.js';

const RECT = { x: 0, y: 0, width: 800, height: 400 };
const overlaps = (a, b) =>
  a.x < b.x + b.width - 1e-6 &&
  b.x < a.x + a.width - 1e-6 &&
  a.y < b.y + b.height - 1e-6 &&
  b.y < a.y + a.height - 1e-6;

describe('squarify', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: i, value: (60 - i) ** 2 }));
  const tiles = squarify(items, RECT);

  test('lays out every item with a positive value', () => {
    assert.equal(tiles.length, items.length);
  });

  test('fills the rectangle', () => {
    const area = tiles.reduce((sum, t) => sum + t.width * t.height, 0);
    const target = RECT.width * RECT.height;
    assert.ok(Math.abs(area - target) / target < 0.001, `covered ${area} of ${target}`);
  });

  test('keeps every tile inside the rectangle', () => {
    for (const t of tiles) {
      assert.ok(t.x >= -1e-6 && t.y >= -1e-6, `tile ${t.id} starts outside`);
      assert.ok(t.x + t.width <= RECT.width + 1e-6, `tile ${t.id} overflows width`);
      assert.ok(t.y + t.height <= RECT.height + 1e-6, `tile ${t.id} overflows height`);
    }
  });

  test('does not overlap tiles', () => {
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        assert.ok(!overlaps(tiles[i], tiles[j]), `tiles ${i} and ${j} overlap`);
      }
    }
  });

  test('areas stay proportional to values', () => {
    const total = items.reduce((s, d) => s + d.value, 0);
    for (const t of tiles) {
      const expected = (t.value / total) * RECT.width * RECT.height;
      assert.ok(Math.abs(t.width * t.height - expected) / expected < 0.01, `tile ${t.id} area is off`);
    }
  });

  test('produces reasonably square tiles rather than slivers', () => {
    // The whole reason to squarify: a slice-and-dice layout yields slivers
    // whose area cannot be judged by eye.
    const ratios = tiles.map((t) => Math.max(t.width / t.height, t.height / t.width)).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    assert.ok(median < 3, `median aspect ratio ${median.toFixed(2)} is too elongated`);
  });

  test('ignores zero and negative values instead of inverting tiles', () => {
    const mixed = squarify([{ value: 10 }, { value: 0 }, { value: -5 }, { value: 5 }], RECT);
    assert.equal(mixed.length, 2);
  });

  test('returns nothing for an empty rectangle', () => {
    assert.deepEqual(squarify([{ value: 1 }], { x: 0, y: 0, width: 0, height: 100 }), []);
  });
});
