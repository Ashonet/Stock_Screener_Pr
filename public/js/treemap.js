/**
 * Squarified treemap layout.
 *
 * The naive alternative, slicing the rectangle alternately by row and column,
 * produces slivers whose area you cannot judge, which defeats the point of
 * sizing by value. Squarifying packs each row so tiles stay as close to square
 * as the values allow (Bruls, Huizing & van Wijk, 2000).
 *
 * Pure geometry: no DOM, no colour, no domain knowledge. Give it values and a
 * rectangle, get back rectangles.
 */

const worst = (row, side, scale) => {
  const sum = row.reduce((a, v) => a + v.value, 0) * scale;
  const max = Math.max(...row.map((v) => v.value)) * scale;
  const min = Math.min(...row.map((v) => v.value)) * scale;
  const side2 = side * side;
  const sum2 = sum * sum;
  return Math.max((side2 * max) / sum2, sum2 / (side2 * min));
};

/**
 * @param {Array<{value:number}>} items  sorted descending by value
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @returns {Array} the same items, each with x/y/width/height added
 */
export function squarify(items, rect) {
  const out = [];
  const queue = items.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  if (!queue.length) return out;

  const total = queue.reduce((a, d) => a + d.value, 0);
  const area = rect.width * rect.height;
  if (area <= 0 || total <= 0) return out;
  const scale = area / total;

  let { x, y, width, height } = rect;
  let index = 0;

  while (index < queue.length) {
    const side = Math.min(width, height);
    if (side <= 0) break;

    // Grow the row while doing so improves the worst aspect ratio in it.
    const row = [queue[index]];
    let next = index + 1;
    while (next < queue.length) {
      const candidate = [...row, queue[next]];
      if (worst(candidate, side, scale) > worst(row, side, scale)) break;
      row.push(queue[next]);
      next++;
    }

    const rowValue = row.reduce((a, d) => a + d.value, 0) * scale;
    const thickness = rowValue / side;
    const horizontal = width >= height;

    let offset = 0;
    for (const item of row) {
      const length = (item.value * scale) / thickness;
      out.push({
        ...item,
        x: horizontal ? x : x + offset,
        y: horizontal ? y + offset : y,
        width: horizontal ? thickness : length,
        height: horizontal ? length : thickness,
      });
      offset += length;
    }

    if (horizontal) {
      x += thickness;
      width -= thickness;
    } else {
      y += thickness;
      height -= thickness;
    }
    index = next;
  }

  return out;
}
