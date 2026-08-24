/**
 * SVG charts, no dependencies.
 *
 * House rules these follow:
 *  - 2px lines, area fills as a ~10% wash, bars capped at 24px with a 4px
 *    rounded data-end and square at the baseline, markers >= 8px with a 2px
 *    surface ring, gridlines as solid hairlines.
 *  - A legend whenever there are two or more series; direct labels used
 *    sparingly (the endpoint / the latest period), never on every point.
 *  - Every chart has a table twin, so no value is reachable only by hovering.
 *  - Hit targets are the band, not the painted mark, and keyboard focus shows
 *    the same readout as hover.
 */

import { el, svg, render, debounce } from './dom.js';
import { arcPath, pointOnCircle } from './pie.js';
import { axisDate } from './format.js';

/* ------------------------------------------------------------------ tooltip */

const tipNode = () => document.getElementById('tooltip');

export function showTooltip(clientX, clientY, content) {
  const node = tipNode();
  if (!node) return;
  render(node, content);
  node.hidden = false;

  // Flip away from the viewport edges rather than overflowing them.
  const box = node.getBoundingClientRect();
  const pad = 14;
  let x = clientX + pad;
  let y = clientY - box.height - pad;
  if (x + box.width > window.innerWidth - 8) x = clientX - box.width - pad;
  if (y < 8) y = clientY + pad;
  if (x < 8) x = 8;
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
}

export function hideTooltip() {
  const node = tipNode();
  if (node) node.hidden = true;
}

/** Tooltip body: value leads, series label follows, keyed by a short stroke. */
export function tooltipBody(title, rows) {
  return [
    el('div', { class: 'tip-title', text: title }),
    ...rows.map(({ label, value, color }) =>
      el(
        'div',
        { class: 'tip-row' },
        color ? el('span', { class: 'tip-key', style: { background: color } }) : null,
        el('span', { class: 'tip-value', text: value }),
        el('span', { class: 'tip-label', text: label }),
      ),
    ),
  ];
}

/* -------------------------------------------------------------- scale utils */

/** Round tick values covering [min, max] in at most `count` steps. */
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) return [min];
  const rawStep = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(rawStep) || 1));
  const normalized = rawStep / magnitude;
  // Snap to the *nearest* round step rather than always rounding up: rounding
  // up turns a 5-tick request into 2 gridlines on narrow price ranges.
  const step =
    [1, 2, 2.5, 5, 10].reduce((best, c) => (Math.abs(c - normalized) < Math.abs(best - normalized) ? c : best)) *
    magnitude;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks.length ? ticks : [min, max];
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Bar path: rounded on the data end, square at the baseline.
 * `value >= 0` grows up from the baseline, negatives grow down.
 */
function barPath(x, width, baselineY, valueY, radius = 4) {
  const height = Math.abs(valueY - baselineY);
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const growsUp = valueY <= baselineY;
  if (height < 0.5) return `M${x} ${baselineY} h${width}`;

  return growsUp
    ? `M${x} ${baselineY} L${x} ${valueY + r} Q${x} ${valueY} ${x + r} ${valueY} ` +
        `L${x + width - r} ${valueY} Q${x + width} ${valueY} ${x + width} ${valueY + r} ` +
        `L${x + width} ${baselineY} Z`
    : `M${x} ${baselineY} L${x} ${valueY - r} Q${x} ${valueY} ${x + r} ${valueY} ` +
        `L${x + width - r} ${valueY} Q${x + width} ${valueY} ${x + width} ${valueY - r} ` +
        `L${x + width} ${baselineY} Z`;
}

/* ------------------------------------------------------------- chart shell */

/**
 * Build a card containing: head (+ Chart/Table toggle), optional legend, a
 * responsive plot frame, and the table twin. `draw(frame, width)` renders the
 * SVG and re-runs on resize.
 */
export function chartCard(container, config) {
  const { title, subtitle, legend = [], draw, table, height = 260, note } = config;

  const frame = el('div', { class: 'chart-frame' });
  const tableWrap = el('div', { class: 'table-scroll', hidden: true });
  if (table) tableWrap.append(dataTable(table.columns, table.rows));

  const chartBtn = el('button', { class: 'link-button', type: 'button', 'aria-pressed': 'true' }, 'Chart');
  const tableBtn = el('button', { class: 'link-button', type: 'button', 'aria-pressed': 'false' }, 'Table');
  const setView = (showTable) => {
    frame.hidden = showTable;
    tableWrap.hidden = !showTable;
    chartBtn.setAttribute('aria-pressed', String(!showTable));
    tableBtn.setAttribute('aria-pressed', String(showTable));
    hideTooltip();
  };
  chartBtn.addEventListener('click', () => setView(false));
  tableBtn.addEventListener('click', () => setView(true));

  render(
    container,
    el(
      'div',
      { class: 'card-head' },
      el('h3', { class: 'card-title', text: title }),
      table ? el('div', { class: 'chart-toggle' }, chartBtn, tableBtn) : null,
    ),
    subtitle ? el('p', { class: 'card-sub', text: subtitle }) : null,
    // A legend is always present for two or more series.
    legend.length >= 2
      ? el(
          'div',
          { class: 'legend' },
          ...legend.map((item) =>
            el(
              'span',
              { class: 'legend-item' },
              el('span', {
                class: item.shape === 'line' ? 'legend-line' : 'legend-swatch',
                style: { background: item.color },
              }),
              el('span', { text: item.name }),
            ),
          ),
        )
      : null,
    frame,
    tableWrap,
    note ? el('p', { class: 'card-sub', style: { marginTop: '10px', marginBottom: 0 }, text: note }) : null,
  );

  const paint = () => {
    const width = Math.max(240, frame.clientWidth || container.clientWidth - 40);
    render(frame, draw(width, height));
  };

  paint();
  const observer = new ResizeObserver(debounce(paint, 90));
  observer.observe(frame);
  /*
   * Re-paint when the system flips between light and dark, so marks pick up the
   * new mode's steps.
   *
   * This used to watch a `data-theme` attribute, which the removed toggle set.
   * With the theme following the operating system there is no attribute to
   * watch and the media query is the only source of truth, so an observer left
   * pointed at the old attribute would simply never fire and charts would keep
   * yesterday's colours until something else forced a repaint.
   */
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', paint);

  return () => {
    observer.disconnect();
    scheme.removeEventListener('change', paint);
  };
}

/** The WCAG-clean twin of any chart. */
export function dataTable(columns, rows) {
  return el(
    'table',
    { class: 'data' },
    el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', { scope: 'col', text: c })))),
    el(
      'tbody',
      {},
      ...rows.map((cells) =>
        el('tr', {}, ...cells.map((cell, i) => el(i === 0 ? 'th' : 'td', i === 0 ? { scope: 'row', text: cell } : { text: cell }))),
      ),
    ),
  );
}

/* ---------------------------------------------------------------- sparkline */

/** Watchlist mini-trend: a bare 2px line, no axes, no interaction of its own. */
export function sparkline(values, { width = 64, height = 26, color }) {
  const clean = values.filter((v) => Number.isFinite(v));
  const node = svg('svg', {
    class: 'wl-spark',
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  if (clean.length < 2) return node;

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const pad = 3;
  const x = (i) => (i / (clean.length - 1)) * width;
  const y = (v) => height - pad - ((v - min) / span) * (height - pad * 2);

  node.append(
    svg('path', {
      d: clean.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' '),
      fill: 'none',
      stroke: color,
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );
  return node;
}

/* --------------------------------------------------------------- area chart */

/**
 * Price history: 2px line over a ~10% wash, crosshair that snaps to the
 * nearest point, and one direct label at the endpoint.
 *
 * X is spaced by index, not clock time. Otherwise every weekend and holiday
 * opens a gap the price never actually spent.
 */
export function areaChart(width, height, opts) {
  const {
    points,
    color,
    formatValue,
    formatTooltip,
    referenceValue = null,
    referenceLabel = 'Prev close',
    endLabel = null,
    ariaLabel,
  } = opts;

  const pad = { top: 14, right: 62, bottom: 26, left: 56 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = Math.max(10, height - pad.top - pad.bottom);

  const node = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    tabindex: '0',
    'aria-label': ariaLabel,
  });

  if (points.length < 2) {
    node.append(
      svg('text', {
        x: width / 2,
        y: height / 2,
        class: 'axis-text',
        'text-anchor': 'middle',
        text: 'Not enough data for this range',
      }),
    );
    return node;
  }

  const values = points.map((p) => p.c);
  let min = Math.min(...values, ...(referenceValue != null ? [referenceValue] : []));
  let max = Math.max(...values, ...(referenceValue != null ? [referenceValue] : []));
  const headroom = (max - min || Math.abs(max) * 0.02 || 1) * 0.08;
  min -= headroom;
  max += headroom;

  const x = (i) => pad.left + (i / (points.length - 1)) * plotW;
  const y = (v) => pad.top + plotH - ((v - min) / (max - min)) * plotH;

  /* grid + y axis, solid hairlines, recessive */
  const ticks = niceTicks(min, max, 5);
  const grid = svg('g', {});
  for (const t of ticks) {
    const ty = y(t);
    if (ty < pad.top - 1 || ty > pad.top + plotH + 1) continue;
    grid.append(svg('line', { class: 'grid-line', x1: pad.left, x2: pad.left + plotW, y1: ty, y2: ty }));
    grid.append(
      svg('text', {
        class: 'axis-text',
        x: pad.left - 9,
        y: ty + 3.5,
        'text-anchor': 'end',
        text: formatValue(t),
      }),
    );
  }
  node.append(grid);

  /* x axis ticks */
  const spanDays = (points.at(-1).t - points[0].t) / 86_400_000;
  const tickCount = Math.max(2, Math.min(7, Math.floor(plotW / 96)));
  const xAxis = svg('g', {});
  for (let k = 0; k < tickCount; k++) {
    const i = Math.round((k / (tickCount - 1)) * (points.length - 1));
    xAxis.append(
      svg('text', {
        class: 'axis-text',
        x: x(i),
        y: pad.top + plotH + 17,
        'text-anchor': k === 0 ? 'start' : k === tickCount - 1 ? 'end' : 'middle',
        text: axisDate(points[i].t, spanDays),
      }),
    );
  }
  node.append(
    svg('line', { class: 'axis-line', x1: pad.left, x2: pad.left + plotW, y1: pad.top + plotH, y2: pad.top + plotH }),
    xAxis,
  );

  /* previous-close reference, a solid hairline, labelled so it is not mystery ink */
  if (referenceValue != null) {
    const ry = y(referenceValue);
    if (ry >= pad.top && ry <= pad.top + plotH) {
      node.append(
        svg('line', { class: 'axis-line', x1: pad.left, x2: pad.left + plotW, y1: ry, y2: ry }),
        svg('text', {
          class: 'axis-text',
          x: pad.left + plotW + 6,
          y: ry + 3.5,
          text: referenceLabel,
        }),
      );
    }
  }

  /* area wash + line */
  const linePath = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)} ${y(p.c).toFixed(2)}`).join(' ');
  const gradientId = `fill-${Math.random().toString(36).slice(2, 9)}`;
  node.append(
    svg(
      'defs',
      {},
      svg(
        'linearGradient',
        { id: gradientId, x1: '0', y1: '0', x2: '0', y2: '1' },
        svg('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '0.16' }),
        svg('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0' }),
      ),
    ),
    svg('path', {
      d: `${linePath} L${x(points.length - 1).toFixed(2)} ${pad.top + plotH} L${pad.left} ${pad.top + plotH} Z`,
      fill: `url(#${gradientId})`,
    }),
    svg('path', {
      d: linePath,
      fill: 'none',
      stroke: color,
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );

  /* endpoint marker + one direct label */
  const lastX = x(points.length - 1);
  const lastY = y(points.at(-1).c);
  node.append(
    svg('circle', { cx: lastX, cy: lastY, r: 4, fill: color, stroke: cssVar('--surface-1'), 'stroke-width': 2 }),
  );
  if (endLabel) {
    node.append(
      svg('text', {
        class: 'mark-label',
        x: Math.min(lastX + 10, width - 4),
        y: Math.max(pad.top + 4, Math.min(lastY + 4, pad.top + plotH)),
        text: endLabel,
      }),
    );
  }

  /* crosshair + tooltip, the reader aims at a date, not at a 2px line */
  const cross = svg('g', { opacity: '0' });
  const crossLine = svg('line', { class: 'crosshair', y1: pad.top, y2: pad.top + plotH });
  const crossDot = svg('circle', { r: 4.5, fill: color, stroke: cssVar('--surface-1'), 'stroke-width': 2 });
  cross.append(crossLine, crossDot);
  node.append(cross);

  let activeIndex = -1;
  const moveTo = (index, clientX, clientY) => {
    const i = Math.max(0, Math.min(points.length - 1, index));
    activeIndex = i;
    const px = x(i);
    const py = y(points[i].c);
    crossLine.setAttribute('x1', px);
    crossLine.setAttribute('x2', px);
    crossDot.setAttribute('cx', px);
    crossDot.setAttribute('cy', py);
    cross.setAttribute('opacity', '1');

    const rect = node.getBoundingClientRect();
    const scale = rect.width / width;
    showTooltip(
      clientX ?? rect.left + px * scale,
      clientY ?? rect.top + py * scale,
      tooltipBody(...formatTooltip(points[i], i)),
    );
  };
  const leave = () => {
    activeIndex = -1;
    cross.setAttribute('opacity', '0');
    hideTooltip();
  };

  const hit = svg('rect', {
    class: 'hit-area',
    x: pad.left,
    y: pad.top,
    width: plotW,
    height: plotH,
  });
  hit.addEventListener('pointermove', (event) => {
    const rect = node.getBoundingClientRect();
    const scale = rect.width / width || 1;
    const localX = (event.clientX - rect.left) / scale;
    const ratioAcross = (localX - pad.left) / plotW;
    moveTo(Math.round(ratioAcross * (points.length - 1)), event.clientX, event.clientY);
  });
  hit.addEventListener('pointerleave', leave);
  node.append(hit);

  // Keyboard reaches the same readout as the pointer.
  node.addEventListener('focus', () => moveTo(activeIndex < 0 ? points.length - 1 : activeIndex));
  node.addEventListener('blur', leave);
  node.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowRight') moveTo(activeIndex + step);
    else if (event.key === 'ArrowLeft') moveTo(activeIndex - step);
    else if (event.key === 'Home') moveTo(0);
    else if (event.key === 'End') moveTo(points.length - 1);
    else if (event.key === 'Escape') return leave();
    else return;
    event.preventDefault();
  });

  return node;
}

/**
 * How many categories to skip between x labels so they do not collide.
 *
 * A label per band is fine for four fiscal years and unreadable for forty-three
 * months: at ~16px a band the text runs into its neighbours and the axis turns
 * to mush. Width is estimated at ~6.2px per character, the same heuristic the
 * bar value labels use, plus a small gutter so adjacent labels do not touch.
 *
 * Callers apply the stride from the RIGHT, so the most recent period is always
 * labelled rather than being left off by one. Nothing is lost by thinning:
 * every band keeps its hit target and tooltip, and the table twin carries all
 * of them.
 */
export function axisLabelStride(labels, band) {
  if (!(band > 0)) return 1;
  const longest = labels.reduce((n, label) => Math.max(n, String(label ?? '').length), 0);
  if (!longest) return 1;
  return Math.max(1, Math.ceil((longest * 6.2 + 10) / band));
}

/* ------------------------------------------------------------- column chart */

/**
 * Grouped columns on a single shared axis. Every series must be in the same
 * unit: two scales on one plot invent a correlation that is not in the data,
 * so a second unit belongs in a second chart.
 */
export function columnChart(width, height, opts) {
  const {
    categories, // [{ label, tooltipLabel? }]
    series, // [{ key, name, color, values: number[] }]
    formatValue,
    formatTick = formatValue,
    labelLast = true,
    ariaLabel,
  } = opts;

  const pad = { top: 22, right: 12, bottom: 30, left: 62 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = Math.max(10, height - pad.top - pad.bottom);

  const node = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label': ariaLabel,
  });

  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  if (!categories.length || !all.length) {
    node.append(
      svg('text', {
        x: width / 2,
        y: height / 2,
        class: 'axis-text',
        'text-anchor': 'middle',
        text: 'No reported data available',
      }),
    );
    return node;
  }

  // The domain always includes zero: a bar chart that does not start at the
  // baseline misstates every ratio the reader takes off it.
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const headroom = (max - min) * 0.12 || 1;
  const domainMax = max + headroom;
  const domainMin = min < 0 ? min - headroom : 0;

  const y = (v) => pad.top + plotH - ((v - domainMin) / (domainMax - domainMin)) * plotH;
  const baselineY = y(0);

  const band = plotW / categories.length;
  const GAP = 2; // the surface gap does the separating, never a stroke

  const labelStride = axisLabelStride(categories.map((c) => c.label), band);
  const groupWidth = Math.min(band - 14, 24 * series.length + GAP * (series.length - 1));
  const barWidth = Math.max(3, (groupWidth - GAP * (series.length - 1)) / series.length);

  /* grid + y axis */
  for (const t of niceTicks(domainMin, domainMax, 4)) {
    const ty = y(t);
    if (ty < pad.top - 1 || ty > pad.top + plotH + 1) continue;
    node.append(
      svg('line', { class: t === 0 ? 'axis-line' : 'grid-line', x1: pad.left, x2: pad.left + plotW, y1: ty, y2: ty }),
      svg('text', { class: 'axis-text', x: pad.left - 9, y: ty + 3.5, 'text-anchor': 'end', text: formatTick(t) }),
    );
  }

  /* bars */
  categories.forEach((category, ci) => {
    const groupLeft = pad.left + band * ci + (band - groupWidth) / 2;

    series.forEach((s, si) => {
      const value = s.values[ci];
      if (!Number.isFinite(value)) return;
      const bx = groupLeft + si * (barWidth + GAP);
      node.append(
        svg('path', {
          d: barPath(bx, barWidth, baselineY, y(value)),
          fill: s.color,
          'data-group': String(ci),
        }),
      );

      // Label selectively: the latest period only, and only where it fits.
      if (labelLast && ci === categories.length - 1 && series.length <= 2) {
        const text = formatValue(value);
        const fits = text.length * 6.2 <= Math.max(barWidth + GAP + 26, 52);
        if (fits) {
          const above = value >= 0;
          // The last bar sits against the right edge, and pad.right is only
          // wide enough for the axis itself, so a centred label on it would
          // hang off the viewBox and be cut in half. Clamped to stay inside.
          const half = (text.length * 6.2) / 2;
          const centre = bx + barWidth / 2;
          node.append(
            svg('text', {
              class: 'mark-label',
              x: Math.min(Math.max(centre, pad.left + half), width - half),
              y: above ? Math.max(11, y(value) - 7) : y(value) + 14,
              'text-anchor': 'middle',
              text,
            }),
          );
        }
      }
    });

    /* x tick, on the stride that fits */
    if ((categories.length - 1 - ci) % labelStride === 0) {
      node.append(
        svg('text', {
          class: 'axis-text',
          x: pad.left + band * ci + band / 2,
          y: pad.top + plotH + 18,
          'text-anchor': 'middle',
          text: category.label,
        }),
      );
    }

    /* the band is the hit target, so the pointer never has to find a thin bar */
    const hit = svg('rect', {
      class: 'hit-area',
      x: pad.left + band * ci,
      y: pad.top,
      width: band,
      height: plotH,
      tabindex: '0',
      role: 'button',
      'aria-label': `${category.tooltipLabel ?? category.label}: ${series
        .map((s) => `${s.name} ${formatValue(s.values[ci])}`)
        .join(', ')}`,
    });
    const showFor = (clientX, clientY) => {
      const rect = node.getBoundingClientRect();
      const scale = rect.width / width || 1;
      showTooltip(
        clientX ?? rect.left + (pad.left + band * ci + band / 2) * scale,
        clientY ?? rect.top + pad.top * scale,
        tooltipBody(
          category.tooltipLabel ?? category.label,
          series
            .filter((s) => Number.isFinite(s.values[ci]))
            .map((s) => ({ label: s.name, value: formatValue(s.values[ci]), color: s.color })),
        ),
      );
    };
    hit.addEventListener('pointermove', (e) => showFor(e.clientX, e.clientY));
    hit.addEventListener('pointerleave', hideTooltip);
    hit.addEventListener('focus', () => showFor());
    hit.addEventListener('blur', hideTooltip);
    node.append(hit);
  });

  return node;
}

export { cssVar };

/* ------------------------------------------------------------ donut chart */

/**
 * Value split as a ring.
 *
 * Colour is the encoding here, which it is not allowed to be anywhere else in
 * this app. That is defensible for a categorical split with no ordering and no
 * direction to carry, and it is why the palette is capped at six: past that,
 * "distinct" colours stop being distinguishable, especially for a colourblind
 * reader. The caller folds the tail before it gets here.
 *
 * Every slice is labelled with its share on the ring, so the reading never
 * depends on matching a colour back to the legend, and the table twin holds the
 * exact values. People compare angles badly; the chart is for the shape of the
 * split and the table is for the numbers.
 */
export function donutChart(width, height, opts) {
  const { slices, total, formatValue, centreLabel, centreValue, ariaLabel } = opts;

  const node = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': ariaLabel });
  if (!slices.length) {
    node.append(
      svg('text', { x: width / 2, y: height / 2, class: 'axis-text', 'text-anchor': 'middle' }, 'Nothing to show'),
    );
    return node;
  }

  const cx = width / 2;
  const cy = height / 2;
  const outer = Math.max(20, Math.min(width, height) / 2 - 26);
  const inner = outer * 0.58;

  for (const slice of slices) {
    const path = svg('path', {
      d: arcPath(cx, cy, outer, inner, slice.startAngle, slice.endAngle),
      fill: slice.color,
      // The 2px gap between slices is the surface showing through, never a
      // stroke: a stroke would sit half outside the arc and shrink it.
      stroke: 'var(--surface-0)',
      'stroke-width': '2',
      tabindex: '0',
      role: 'listitem',
      'aria-label': `${slice.label}: ${formatValue(slice.value)}, ${slice.share.toFixed(1)}%`,
    });

    const show = (clientX, clientY) => {
      const box = node.getBoundingClientRect();
      const scale = box.width / width || 1;
      const at = pointOnCircle(cx, cy, (outer + inner) / 2, slice.midAngle);
      showTooltip(
        clientX ?? box.left + at.x * scale,
        clientY ?? box.top + at.y * scale,
        tooltipBody(slice.label, [
          { label: 'Value', value: formatValue(slice.value), color: slice.color },
          { label: 'Share', value: `${slice.share.toFixed(1)}%` },
        ]),
      );
    };

    path.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
    path.addEventListener('pointerleave', hideTooltip);
    path.addEventListener('focus', () => show());
    path.addEventListener('blur', hideTooltip);
    node.append(path);

    // Only where it fits. A label on a 2% slice overlaps its neighbours and
    // makes both unreadable, and the table twin has it either way.
    if (slice.share >= 7) {
      const at = pointOnCircle(cx, cy, (outer + inner) / 2, slice.midAngle);
      node.append(
        svg(
          'text',
          {
            x: at.x,
            y: at.y + 4,
            class: 'donut-label',
            'text-anchor': 'middle',
          },
          `${Math.round(slice.share)}%`,
        ),
      );
    }
  }

  if (centreValue) {
    node.append(
      svg('text', { x: cx, y: cy - 4, class: 'donut-centre-value', 'text-anchor': 'middle' }, centreValue),
      svg('text', { x: cx, y: cy + 16, class: 'donut-centre-label', 'text-anchor': 'middle' }, centreLabel ?? ''),
    );
  }

  return node;
}
