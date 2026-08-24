/**
 * Donut layout and the grouping that feeds it.
 *
 * Pure geometry and pure arithmetic: no DOM, no colour, no domain knowledge.
 * Give it values, get back angles and paths.
 *
 * A donut rather than a full pie. The hole costs nothing, because the centre of
 * a pie is where the slices are thinnest and hardest to compare anyway, and it
 * buys a place to put the total that would otherwise need its own line of text.
 *
 * The honest caveat about this whole chart type: people read angles badly, and
 * two slices within a few points of each other are genuinely hard to rank by
 * eye. That is why every slice is labelled with its share and why the table
 * twin carries the exact numbers. The chart is for the shape of the split, the
 * table is for the values.
 */

const TAU = Math.PI * 2;

/**
 * Point on a circle at `angle`, measured clockwise from twelve o'clock.
 *
 * SVG's y axis points down and its angles start at three o'clock, so the
 * conversion is baked in here rather than repeated at every call site.
 */
export function pointOnCircle(cx, cy, radius, angle) {
  const a = angle - Math.PI / 2;
  return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
}

/**
 * The path for one ring segment.
 *
 * A full circle cannot be drawn as a single arc, because the start and end
 * points coincide and the renderer has no way to tell a whole turn from no turn
 * at all. A lone slice is therefore drawn as two half arcs.
 */
export function arcPath(cx, cy, outerRadius, innerRadius, startAngle, endAngle) {
  const sweep = endAngle - startAngle;
  if (sweep <= 0) return '';

  if (sweep >= TAU - 1e-9) {
    const mid = startAngle + Math.PI;
    return (
      arcPath(cx, cy, outerRadius, innerRadius, startAngle, mid) +
      ' ' +
      arcPath(cx, cy, outerRadius, innerRadius, mid, startAngle + TAU)
    );
  }

  const large = sweep > Math.PI ? 1 : 0;
  const o0 = pointOnCircle(cx, cy, outerRadius, startAngle);
  const o1 = pointOnCircle(cx, cy, outerRadius, endAngle);
  const i1 = pointOnCircle(cx, cy, innerRadius, endAngle);
  const i0 = pointOnCircle(cx, cy, innerRadius, startAngle);

  return [
    `M${o0.x.toFixed(2)} ${o0.y.toFixed(2)}`,
    `A${outerRadius} ${outerRadius} 0 ${large} 1 ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
    `L${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
    `A${innerRadius} ${innerRadius} 0 ${large} 0 ${i0.x.toFixed(2)} ${i0.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

/**
 * Turn values into angles, largest first.
 *
 * Sorted because an unordered donut makes the reader hunt for the biggest
 * slice, and starting at twelve o'clock because that is where they look.
 * Zero and negative values are dropped: a short position is a real thing but it
 * has no angle, and rendering it would either vanish or, worse, silently invert
 * the slice after it.
 */
export function sliceLayout(items, { startAngle = 0 } = {}) {
  const usable = items.filter((item) => Number.isFinite(item.value) && item.value > 0);
  const total = usable.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return { slices: [], total: 0, dropped: items.length };

  const sorted = [...usable].sort((a, b) => b.value - a.value);
  let angle = startAngle;

  const slices = sorted.map((item) => {
    const sweep = (item.value / total) * TAU;
    const slice = {
      ...item,
      share: (item.value / total) * 100,
      startAngle: angle,
      endAngle: angle + sweep,
      midAngle: angle + sweep / 2,
    };
    angle += sweep;
    return slice;
  });

  return { slices, total, dropped: items.length - usable.length };
}

/**
 * Group rows onto one facet, keeping the largest and folding the rest.
 *
 * The fold exists because colour is the encoding here and the categorical
 * palette only holds so many genuinely distinguishable hues. A portfolio can
 * hold forty industries, and rendering forty is rendering none.
 *
 * But a fixed cut at six slices made "Other" the story rather than the
 * remainder: a ten-holding wallet split across ten industries folded five of
 * them into a single 32% wedge, the largest thing on the chart and the one
 * saying the least. A remainder that outweighs the parts is not a remainder.
 *
 * So the cut is driven by what is left over rather than by a slice count.
 * Named slices are kept, largest first, until the tail is at or under
 * `maxOtherShare` of the total, and only then folded. `maxSlices` remains as a
 * ceiling for the pathological case, a hundred holdings each worth 1%, where no
 * amount of slicing gets the tail down and something has to give.
 *
 * The tail is still returned in full, because the table twin should list what
 * "Other" contains rather than making the reader take it on trust.
 */
export function groupByFacet(rows, facet, { maxSlices = 16, maxOtherShare = 10, otherLabel = 'Other' } = {}) {
  const buckets = new Map();

  for (const row of rows) {
    if (!Number.isFinite(row.value) || row.value <= 0) continue;
    // A missing facet is named rather than dropped: "Unclassified" is a fact
    // about the data, and silently omitting those rows would make the shares
    // add up to less than the portfolio.
    const key = row[facet] ?? 'Unclassified';
    if (!buckets.has(key)) buckets.set(key, { label: key, value: 0, members: [] });
    const bucket = buckets.get(key);
    bucket.value += row.value;
    bucket.members.push(row);
  }

  const ordered = [...buckets.values()].sort((a, b) => b.value - a.value);
  if (ordered.length <= maxSlices) return ordered;

  const total = ordered.reduce((sum, bucket) => sum + bucket.value, 0);

  // How many to name before the rest is small enough to be a remainder. One
  // slot is always reserved for the fold itself, or the chart would draw
  // maxSlices + 1.
  const ceiling = Math.max(1, maxSlices - 1);
  let keep = 1;
  while (keep < ceiling) {
    const tailValue = ordered.slice(keep).reduce((sum, bucket) => sum + bucket.value, 0);
    if (total <= 0 || (tailValue / total) * 100 <= maxOtherShare) break;
    keep++;
  }

  const kept = ordered.slice(0, keep);
  const tail = ordered.slice(keep);
  if (!tail.length) return kept;

  kept.push({
    label: otherLabel,
    value: tail.reduce((sum, bucket) => sum + bucket.value, 0),
    members: tail.flatMap((bucket) => bucket.members),
    folded: tail.length,
    foldedLabels: tail.map((bucket) => bucket.label),
  });
  return kept;
}
