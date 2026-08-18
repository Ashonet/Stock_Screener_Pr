/**
 * Tests for x-axis label thinning.
 *
 * The bug: the column chart drew a tick label for every category, always. That
 * is fine for four fiscal years and unreadable for a wallet's forty-three
 * months of dividend income, where each band is about 16px and each label
 * "Mar 26" needs roughly 47px. The labels ran straight through each other.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { axisLabelStride } from '../public/js/charts.js';

/** Labels a wallet's monthly income chart produces. */
const months = (n) => Array.from({ length: n }, (_, i) => `${['Jan', 'Feb', 'Mar', 'Apr'][i % 4]} ${20 + (i % 9)}`);

describe('axisLabelStride', () => {
  test('labels every band when they all fit', () => {
    // Four fiscal years across a normal card: nothing needs skipping.
    assert.equal(axisLabelStride(['FY2023', 'FY2024', 'FY2025', 'FY2026'], 160), 1);
  });

  test('thins the axis when the labels are wider than the band', () => {
    // The real case: 43 months in a ~790px plot is an 18px band, and a 6-char
    // label needs about 47px, so roughly every third month gets a label.
    const stride = axisLabelStride(months(43), 790 / 43);
    assert.equal(stride, 3);

    // The surviving labels must actually clear each other.
    const band = 790 / 43;
    assert.ok(stride * band >= 6 * 6.2, 'spacing covers the widest label');
  });

  test('the stride grows as the plot narrows', () => {
    const wide = axisLabelStride(months(43), 790 / 43);
    const narrow = axisLabelStride(months(43), 320 / 43);
    assert.ok(narrow > wide, `${narrow} should exceed ${wide} on a narrower plot`);
  });

  test('sizes to the longest label, not the first', () => {
    // A short first label would otherwise let a long one later overlap.
    const short = axisLabelStride(['Jan', 'Feb', 'Mar'], 30);
    const long = axisLabelStride(['Jan', 'September 2026', 'Mar'], 30);
    assert.ok(long > short);
  });

  test('degenerate inputs fall back to labelling everything', () => {
    assert.equal(axisLabelStride([], 100), 1);
    assert.equal(axisLabelStride(['a'], 0), 1);
    assert.equal(axisLabelStride(['a'], -5), 1);
    assert.equal(axisLabelStride([null, undefined], 100), 1);
  });

  test('counting the stride from the right always labels the latest period', () => {
    // How the caller applies it. The newest category is the one a reader looks
    // for first, so it must never be the one that gets skipped.
    for (const count of [7, 12, 43, 60]) {
      const stride = axisLabelStride(months(count), 790 / count);
      const labelled = [...Array(count).keys()].filter((i) => (count - 1 - i) % stride === 0);
      assert.ok(labelled.includes(count - 1), `latest labelled with ${count} categories`);
    }
  });
});
