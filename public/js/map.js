/**
 * Market map: the index as a treemap.
 *
 * Tiles are sized by market capitalisation and grouped by sector, so the shape
 * of the index is visible at a glance, a question none of the per-company
 * views can answer.
 *
 * On colour. Direction is a diverging scale, and the app already reads
 * green-up / red-down everywhere else, so the map follows suit rather than
 * introducing a second vocabulary for the same fact. That pairing is the one
 * red-green viewers struggle with, so colour is never the only channel: the
 * move is printed on every tile with room for it, every tile carries a tooltip
 * and a keyboard focus state, and the table view lists all of them. The
 * "quality score" mode is a single blue ramp, legible under any colour vision.
 */

import { el, svg, render } from './dom.js';
import { squarify } from './treemap.js';
import { showTooltip, hideTooltip, tooltipBody, dataTable, cssVar } from './charts.js';
import { DASH, compactCurrency, percent, shortDate } from './format.js';

const MODES = [
  { key: 'change', label: 'Day change' },
  { key: 'score', label: 'Quality score' },
];

/** Diverging around zero. Three percent saturates, a big day for a large cap. */
function changeColour(pct) {
  if (pct == null) return 'var(--surface-2)';
  const t = Math.max(-1, Math.min(1, pct / 3));
  const base = t >= 0 ? cssVar('--up') : cssVar('--down');
  const strength = 12 + Math.abs(t) * 68;
  return `color-mix(in srgb, ${base} ${strength.toFixed(0)}%, var(--surface-2))`;
}

/** Sequential: one hue, light to dark, as a magnitude scale should be. */
function scoreColour(score) {
  if (score == null) return 'var(--surface-2)';
  const strength = 12 + (Math.max(0, Math.min(100, score)) / 100) * 72;
  return `color-mix(in srgb, ${cssVar('--series-1')} ${strength.toFixed(0)}%, var(--surface-2))`;
}

const tileColour = (row, mode) => (mode === 'score' ? scoreColour(row.overall_score) : changeColour(row.change_pct));

const signedPct = (v) => (v == null ? DASH : `${v > 0 ? '+' : ''}${percent(v, { digits: 1 })}`);

const tileValue = (row, mode) =>
  mode === 'score'
    ? row.overall_score == null
      ? DASH
      : String(Math.round(row.overall_score))
    : signedPct(row.change_pct);

/**
 * Fit the sector heading to its tile, or leave it out.
 *
 * A label wider than its own tile does not get clipped by anything. It runs on
 * over the neighbouring sector, which is worse than silence. So the total is
 * dropped first, then the name is truncated, and below the width where even a
 * short name would collide the heading is omitted and the tooltip carries it.
 */
function sectorHeading(sector, width) {
  // ~6.6px per character at 11px uppercase with the tracking applied.
  const fits = (text) => text.length * 6.6 <= width - 6;

  const full = `${sector.sector} · ${compactCurrency(sector.marketCap, 'USD')}`;
  if (fits(full)) return full;
  if (fits(sector.sector)) return sector.sector;

  const budget = Math.floor((width - 6) / 6.6) - 1;
  return budget >= 4 ? `${sector.sector.slice(0, budget)}…` : null;
}

function drawSector(sector, rect, mode, handlers) {
  const heading = sectorHeading(sector, rect.width);
  // Reclaim the header band when there is no heading to put in it.
  const HEADER = heading ? 20 : 4;
  const nodes = heading
    ? [
        svg('text', {
          x: rect.x + 3,
          y: rect.y + 13,
          class: 'map-sector-label',
          text: heading,
        }),
      ]
    : [];

  const inner = { x: rect.x, y: rect.y + HEADER, width: rect.width, height: Math.max(0, rect.height - HEADER) };
  const tiles = squarify(
    sector.children.map((row) => ({ ...row, value: row.market_cap ?? 0 })),
    inner,
  );

  for (const tile of tiles) {
    // The 1px inset is surface showing through, and that gap is what separates
    // neighbouring tiles. A stroke around each would add ink that is not data.
    const w = Math.max(0, tile.width - 1);
    const h = Math.max(0, tile.height - 1);
    if (w <= 0 || h <= 0) continue;

    const cell = svg('g', {
      class: 'map-tile',
      tabindex: '0',
      role: 'button',
      'aria-label': `${tile.symbol}, ${tile.name}, ${tileValue(tile, mode)}`,
    });

    cell.append(svg('rect', { x: tile.x, y: tile.y, width: w, height: h, fill: tileColour(tile, mode), rx: 2 }));

    // Label only where it fits. Clipped text is worse than no text.
    if (w >= 34 && h >= 22) {
      cell.append(
        svg('text', {
          x: tile.x + w / 2,
          y: tile.y + h / 2 + (h >= 34 ? -3 : 4),
          class: 'map-symbol',
          'text-anchor': 'middle',
          text: tile.symbol,
        }),
      );
      if (h >= 34) {
        cell.append(
          svg('text', {
            x: tile.x + w / 2,
            y: tile.y + h / 2 + 12,
            class: 'map-value',
            'text-anchor': 'middle',
            text: tileValue(tile, mode),
          }),
        );
      }
    }

    const show = (event) =>
      showTooltip(
        event?.clientX,
        event?.clientY,
        tooltipBody(`${tile.symbol} · ${tile.name}`, [
          { label: 'Market cap', value: compactCurrency(tile.market_cap, 'USD') },
          { label: 'Day change', value: signedPct(tile.change_pct), color: changeColour(tile.change_pct) },
          {
            label: 'Quality score',
            value: tile.overall_score == null ? DASH : `${Math.round(tile.overall_score)} ${tile.grade ?? ''}`.trim(),
          },
          { label: 'Sector', value: tile.sector },
        ]),
      );

    cell.addEventListener('pointermove', show);
    cell.addEventListener('pointerleave', hideTooltip);
    cell.addEventListener('focus', () => show());
    cell.addEventListener('blur', hideTooltip);
    cell.addEventListener('click', () => handlers.onSelectSymbol(tile.symbol));
    cell.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      handlers.onSelectSymbol(tile.symbol);
    });

    nodes.push(cell);
  }
  return nodes;
}

function draw(width, height, data, mode, handlers) {
  const node = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label': `Treemap of ${data.total} companies, sized by market capitalisation`,
  });

  // Sectors are themselves laid out by combined market cap, so this is a
  // treemap of treemaps rather than an arbitrary grid of panels.
  const sectorTiles = squarify(
    data.sectors.map((s) => ({ ...s, value: s.marketCap })),
    { x: 0, y: 0, width, height },
  );

  for (const sector of sectorTiles) {
    node.append(
      ...drawSector(
        sector,
        { x: sector.x + 1, y: sector.y + 1, width: sector.width - 2, height: sector.height - 2 },
        mode,
        handlers,
      ),
    );
  }
  return node;
}

export function renderMap({ node, data, state, handlers }) {
  const head = (extra) =>
    el(
      'div',
      { class: 'card-head' },
      el('h3', { class: 'card-title', text: 'Market map' }),
      // The warehouse tracks several thousand companies and this draws 500 of
      // them. Saying so is the difference between a view and a wrong one: a
      // treemap that silently omits most of its universe still looks complete.
      el('span', { class: 'card-sub', style: { marginBottom: 0 }, text: 'S&P 500, sized by market cap' }),
      extra ?? null,
    );

  if (!data) {
    render(node, head(), el('p', { class: 'empty', text: 'Loading the warehouse…' }));
    return;
  }
  if (data.error) {
    render(node, head(), el('p', { class: 'error-note', text: data.error }));
    return;
  }

  const frame = el('div', { class: 'map-frame' });
  const table = el('div', { class: 'table-scroll', hidden: true });

  const rows = data.sectors.flatMap((s) => s.children).sort((a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0));
  table.append(
    dataTable(
      ['Symbol', 'Name', 'Sector', 'Market cap', 'Day change', 'Score'],
      rows.map((r) => [
        r.symbol,
        r.name,
        r.sector,
        compactCurrency(r.market_cap, 'USD'),
        signedPct(r.change_pct),
        r.overall_score == null ? DASH : String(Math.round(r.overall_score)),
      ]),
    ),
  );

  const mapBtn = el('button', { class: 'link-button', type: 'button', 'aria-pressed': 'true', text: 'Map' });
  const tableBtn = el('button', { class: 'link-button', type: 'button', 'aria-pressed': 'false', text: 'Table' });
  const setView = (showTable) => {
    frame.hidden = showTable;
    table.hidden = !showTable;
    mapBtn.setAttribute('aria-pressed', String(!showTable));
    tableBtn.setAttribute('aria-pressed', String(showTable));
    hideTooltip();
  };
  mapBtn.addEventListener('click', () => setView(false));
  tableBtn.addEventListener('click', () => setView(true));

  render(
    node,
    head(el('div', { class: 'chart-toggle' }, mapBtn, tableBtn)),
    el('p', {
      class: 'card-sub',
      text:
        `${data.total} companies, sized by market capitalisation` +
        (data.asOf ? ` · closes of ${shortDate(Date.parse(data.asOf))}` : ''),
    }),
    el(
      'div',
      { class: 'filter-row', style: { marginBottom: '12px' } },
      el(
        'div',
        { class: 'filter-group' },
        el('span', { class: 'filter-label', text: 'Colour by' }),
        el(
          'div',
          { class: 'segmented' },
          ...MODES.map((m) =>
            el('button', {
              type: 'button',
              text: m.label,
              'aria-pressed': String(state.mode === m.key),
              onclick: () => handlers.onMode(m.key),
            }),
          ),
        ),
      ),
      el('span', {
        class: 'card-sub',
        style: { marginBottom: 0 },
        text: state.mode === 'score' ? 'Lighter means a lower score' : 'Green up, red down, 3% saturates',
      }),
    ),
    frame,
    table,
  );

  const paint = () => {
    const width = Math.max(320, frame.clientWidth || node.clientWidth - 40);
    const height = Math.max(420, Math.round(width * 0.58));
    render(frame, draw(width, height, data, state.mode, handlers));
  };

  paint();
  new ResizeObserver(paint).observe(frame);
  // Tile fills are mixed from CSS variables, so a theme change has to repaint.
  // Watched through the media query rather than an attribute: the theme follows
  // the operating system now, and nothing sets an attribute to observe.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
}
