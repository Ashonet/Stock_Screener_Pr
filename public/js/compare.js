/**
 * Compare view: several securities rebased to the same start and the same
 * starting amount, drawn as total return or price return.
 *
 * The reason this view exists is the toggle. A price chart tells you what a
 * share did; it does not tell you what owning it did, and for anything with a
 * meaningful yield those are different questions with different answers. Realty
 * Income's price is roughly flat over the window while the position is well
 * ahead, and no price chart anywhere shows that.
 *
 * Colour distinguishes series here, which is a case where it has to: there is
 * no ordering to encode and no direction to carry. So the palette is the
 * validated categorical one, every line is directly labelled at its endpoint,
 * the legend is always present, and the table twin holds every value.
 */

import { el, svg, render } from './dom.js';
import { chartCard, niceTicks, showTooltip, hideTooltip, cssVar } from './charts.js';
import { axisDate, compact, currency, percent, shortDate } from './format.js';

/** Categorical series tokens, in the order they are handed out. */
const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];

const signed = (v) => (v == null ? '' : `${v > 0 ? '+' : ''}${percent(v, { digits: 1 })}`);

/* -------------------------------------------------------------------- plot */

/**
 * Multi-line plot on one shared, rebased axis.
 *
 * Every series starts at the same value by construction, so a single linear
 * axis is honest here in a way it would not be for raw prices.
 */
function comparePlot(width, height, { series, base, formatValue, ariaLabel }) {
  const pad = { top: 18, right: 74, bottom: 28, left: 62 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = Math.max(10, height - pad.top - pad.bottom);

  const node = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': ariaLabel });

  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return node;

  const times = all.map((p) => p.t);
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const values = all.map((p) => p.c);
  const ticks = niceTicks(Math.min(...values), Math.max(...values), 5);
  const minV = Math.min(ticks[0], ...values);
  const maxV = Math.max(ticks.at(-1), ...values);

  const x = (t) => pad.left + ((t - minT) / (maxT - minT || 1)) * plotW;
  const y = (v) => pad.top + plotH - ((v - minV) / (maxV - minV || 1)) * plotH;

  /* grid and axes, solid hairlines, recessive */
  const grid = svg('g', { class: 'grid' });
  for (const tick of ticks) {
    grid.append(
      svg('line', { x1: pad.left, x2: pad.left + plotW, y1: y(tick), y2: y(tick), class: 'grid-line' }),
      svg('text', { x: pad.left - 8, y: y(tick) + 4, class: 'axis-text', 'text-anchor': 'end' }, formatValue(tick)),
    );
  }
  node.append(grid);

  // The starting amount is the reference every line is measured against, so it
  // is drawn as a named reference rather than left as one gridline among five.
  node.append(
    svg('line', { x1: pad.left, x2: pad.left + plotW, y1: y(base), y2: y(base), class: 'ref-line' }),
    svg('text', { x: pad.left + plotW, y: y(base) - 6, class: 'axis-text', 'text-anchor': 'end' }, 'start'),
  );

  const spanDays = (maxT - minT) / 86_400_000;
  for (let i = 0; i <= 4; i++) {
    const t = minT + ((maxT - minT) * i) / 4;
    node.append(
      svg('text', { x: x(t), y: height - 8, class: 'axis-text', 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, axisDate(t, spanDays)),
    );
  }

  for (const s of series) {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(2)} ${y(p.c).toFixed(2)}`).join(' ');
    node.append(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    // Direct endpoint labels: with up to six lines a legend alone makes the
    // reader count colours back and forth across the plot.
    const last = s.points.at(-1);
    node.append(
      svg('text', { x: x(last.t) + 6, y: y(last.c) + 4, class: 'axis-text', fill: s.color, 'font-weight': '600' }, s.symbol),
    );
  }

  /* crosshair and tooltip: the reader aims at a date, not at a 2px line */
  const cross = svg('line', { y1: pad.top, y2: pad.top + plotH, class: 'crosshair', opacity: '0' });
  node.append(cross);

  const nearest = (t) => (points) =>
    points.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), points[0]);

  const move = (event) => {
    const box = node.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    if (px < pad.left || px > pad.left + plotW) return;
    const t = minT + ((px - pad.left) / plotW) * (maxT - minT);

    const rows = series
      .map((s) => ({ s, point: nearest(t)(s.points) }))
      .sort((a, b) => b.point.c - a.point.c);

    cross.setAttribute('x1', x(rows[0].point.t));
    cross.setAttribute('x2', x(rows[0].point.t));
    cross.setAttribute('opacity', '1');

    showTooltip(event.clientX, event.clientY, [
      el('div', { class: 'tip-title', text: shortDate(rows[0].point.t) }),
      ...rows.map(({ s, point }) =>
        el(
          'div',
          { class: 'tip-row' },
          el('span', { class: 'tip-key', style: { background: s.color } }),
          el('span', { class: 'tip-value', text: formatValue(point.c) }),
          el('span', { class: 'tip-label', text: `${s.symbol} ${signed((point.c / base - 1) * 100)}` }),
        ),
      ),
    ]);
  };

  node.addEventListener('pointermove', move);
  node.addEventListener('pointerleave', () => {
    cross.setAttribute('opacity', '0');
    hideTooltip();
  });

  return node;
}

/* -------------------------------------------------------------------- view */

export function renderCompare({ node, data, state, handlers }) {
  const form = buildForm(state, handlers);

  if (data?.error) {
    render(node, form, el('p', { class: 'error-note', text: data.error }));
    return;
  }
  if (!data) {
    render(node, form, el('p', { class: 'empty', text: 'Loading.' }));
    return;
  }
  if (!data.series?.length) {
    render(node, form, el('p', { class: 'empty', text: 'Nothing to compare. Add at least two tickers with overlapping history.' }));
    return;
  }

  const totalReturn = state.mode === 'total';
  const base = data.base ?? 10_000;
  const series = data.series.map((s, i) => ({
    symbol: s.symbol,
    name: s.name ?? s.symbol,
    color: cssVar(SERIES_VARS[i % SERIES_VARS.length]),
    points: totalReturn ? s.total : s.price,
  }));

  const start = data.startedAt ? shortDate(data.startedAt) : null;
  const years = data.series[0]?.years;

  const chartHost = el('div', { class: 'card card-chart' });
  const summary = el('div', { class: 'card' });

  render(node, form, chartHost, summary);

  chartCard(chartHost, {
    title: totalReturn ? 'Growth of $10,000, dividends reinvested' : 'Growth of $10,000, price only',
    subtitle: [
      start ? `from ${start}` : null,
      years ? `${years.toFixed(1)} years` : null,
      'every series rebased to the same start',
    ]
      .filter(Boolean)
      .join(' · '),
    height: 380,
    legend: series.map((s) => ({ name: `${s.symbol} · ${s.name}`, color: s.color, shape: 'line' })),
    draw: (width, height) =>
      comparePlot(width, height, {
        series,
        base,
        formatValue: (v) => `$${compact(v)}`,
        ariaLabel: `${totalReturn ? 'Total return' : 'Price return'} of ${series.map((s) => s.symbol).join(', ')}`,
      }),
    note: data.unavailable?.length ? `No history available for ${data.unavailable.join(', ')}.` : null,
    table: {
      columns: ['Date', ...series.map((s) => s.symbol)],
      // The spine is the first series' dates; every series shares a calendar
      // because they all come from the same monthly sampling.
      rows: series[0].points
        .map((point, i) => [shortDate(point.t), ...series.map((s) => (s.points[i] ? currency(s.points[i].c, 'USD') : ''))])
        .reverse(),
    },
  });

  renderSummary(summary, data, series, totalReturn);
}

function renderSummary(node, data, series, totalReturn) {
  const colourOf = new Map(series.map((s) => [s.symbol, s.color]));

  render(
    node,
    el(
      'div',
      { class: 'card-head' },
      el('h3', { class: 'card-title', text: 'Where the return came from' }),
      el('span', {
        class: 'card-sub',
        style: { marginBottom: 0 },
        text: totalReturn ? 'total return shown above' : 'price return shown above',
      }),
    ),
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        { class: 'data' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            ...['Symbol', 'Price return', 'Total return', 'From dividends', 'Dividend share', 'Total CAGR'].map((label) =>
              el('th', { scope: 'col', text: label }),
            ),
          ),
        ),
        el(
          'tbody',
          {},
          ...data.series.map((s) =>
            el(
              'tr',
              {},
              el(
                'th',
                { scope: 'row' },
                el('span', { class: 'legend-line', style: { background: colourOf.get(s.symbol), marginRight: '8px' } }),
                s.symbol,
              ),
              el('td', { text: signed(s.priceReturn) }),
              el('td', { text: signed(s.totalReturn) }),
              el('td', { text: signed(s.dividendContribution) }),
              // Left blank rather than shown as a share of a loss, which is not
              // a quantity a reader can act on.
              el('td', { text: s.dividendShare == null ? '' : percent(s.dividendShare, { digits: 0 }) }),
              el('td', { text: s.totalCagr == null ? '' : percent(s.totalCagr, { digits: 1 }) }),
            ),
          ),
        ),
      ),
    ),
    el('p', {
      class: 'card-sub',
      style: { marginTop: '12px', marginBottom: 0 },
      text:
        'Total return assumes distributions are reinvested on the ex-date, which is what the adjusted close encodes. ' +
        'It ignores tax and dealing costs, both of which fall harder on the dividend half than on the price half.',
    }),
  );
}

/* -------------------------------------------------------------------- form */

function buildForm(state, handlers) {
  const input = el('input', {
    type: 'text',
    class: 'field compare-field',
    value: state.symbols.join(', '),
    placeholder: 'Up to six tickers, comma separated',
    'aria-label': 'Tickers to compare',
    spellcheck: 'false',
    autocomplete: 'off',
  });

  const modeButton = (mode, label, title) =>
    el('button', {
      type: 'button',
      text: label,
      title,
      'aria-pressed': String(state.mode === mode),
      onclick: () => handlers.onMode(mode),
    });

  const yearsSelect = el(
    'select',
    { class: 'field compare-years', 'aria-label': 'Window', onchange: (e) => handlers.onYears(Number(e.target.value)) },
    ...[3, 5, 10, 20].map((y) => el('option', { value: String(y), selected: state.years === y ? '' : null, text: `${y}y` })),
  );

  return el(
    'form',
    {
      class: 'compare-form',
      onsubmit: (event) => {
        event.preventDefault();
        handlers.onSymbols(input.value);
      },
    },
    input,
    yearsSelect,
    el('button', { class: 'primary-button', type: 'submit', text: 'Compare' }),
    el(
      'div',
      { class: 'segmented' },
      modeButton('total', 'Total return', 'Price plus dividends reinvested'),
      modeButton('price', 'Price only', 'Price movement alone, dividends excluded'),
    ),
  );
}
