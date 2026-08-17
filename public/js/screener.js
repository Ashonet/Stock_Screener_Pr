/**
 * Screener: every tracked security ranked by quality score.
 *
 * This view exists because of the warehouse. Scoring 80 companies from four
 * years of statements would be ~300 upstream calls against the live API — far
 * past what a page load can do and past what the upstream would tolerate.
 * Against the mart it is a single local query, so ranking, filtering and
 * re-sorting are instant.
 */

import { el, render } from './dom.js';
import { DASH, compactCurrency, percent, ratio } from './format.js';

const COLUMNS = [
  { key: 'symbol', label: 'Symbol', kind: 'symbol', align: 'left' },
  { key: 'name', label: 'Name', kind: 'text', align: 'left' },
  { key: 'sector', label: 'Sector', kind: 'text', align: 'left' },
  { key: 'scoring_basis', label: 'Basis', kind: 'basis', align: 'left' },
  { key: 'overall_score', label: 'Score', kind: 'score' },
  { key: 'grade', label: 'Grade', kind: 'text' },
  { key: 'pillar_dividend', label: 'Income', kind: 'pillar' },
  { key: 'pillar_balance_sheet', label: 'Balance', kind: 'pillar' },
  { key: 'pillar_growth', label: 'Growth', kind: 'pillar' },
  { key: 'pillar_profitability', label: 'Profit', kind: 'pillar' },
  { key: 'pillar_valuation', label: 'Value', kind: 'pillar' },
  { key: 'valuation_multiple', label: 'P/E · P/FFO', kind: 'multiple' },
  { key: 'payout_pct', label: 'Payout', kind: 'percent' },
  { key: 'net_debt_to_ebitda', label: 'Net debt/EBITDA', kind: 'multiple' },
  { key: 'revenue_cagr_pct', label: 'Rev CAGR', kind: 'percent' },
  { key: 'market_cap', label: 'Market cap', kind: 'currency' },
];

/** REIT rows are priced on P/FFO, standard rows on P/E — one column, right metric. */
const valuationMultiple = (row) => (row.is_reit ? row.price_to_ffo : row.trailing_pe);

const cellValue = (row, column) =>
  column.key === 'valuation_multiple' ? valuationMultiple(row) : row[column.key];

function scoreTone(score) {
  if (!Number.isFinite(score)) return 'var(--text-muted)';
  if (score >= 70) return 'var(--up)';
  if (score >= 45) return 'var(--warning)';
  return 'var(--down)';
}

function formatCell(value, kind) {
  if (value == null || value === '') return DASH;
  switch (kind) {
    case 'currency':
      return compactCurrency(value, 'USD');
    case 'percent':
      return percent(value, { digits: 1 });
    case 'multiple':
      return `${ratio(value, { digits: 1 })}×`;
    case 'score':
    case 'pillar':
      return String(Math.round(value));
    default:
      return String(value);
  }
}

export function renderScreener({ node, data, state, handlers }) {
  if (!data) {
    render(
      node,
      el('div', { class: 'card-head' }, el('h3', { class: 'card-title', text: 'Screener' })),
      el('p', { class: 'empty', text: 'Loading the warehouse…' }),
    );
    return;
  }

  if (data.error) {
    render(
      node,
      el('div', { class: 'card-head' }, el('h3', { class: 'card-title', text: 'Screener' })),
      el('p', { class: 'error-note', text: data.error }),
      el('p', {
        class: 'card-sub',
        text: 'Build it with:  node pipeline/extract.js --full  &&  npm run warehouse',
      }),
    );
    return;
  }

  const rows = [...data.rows].sort((a, b) => {
    const column = COLUMNS.find((c) => c.key === state.sortKey) ?? COLUMNS[4];
    const av = cellValue(a, column);
    const bv = cellValue(b, column);
    // Nulls always sort last, whichever direction the column is going.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return state.sortDir === 'asc' ? cmp : -cmp;
  });

  const header = el(
    'tr',
    {},
    ...COLUMNS.map((column) =>
      el(
        'th',
        {
          scope: 'col',
          class: 'sortable',
          style: column.align === 'left' ? { textAlign: 'left' } : null,
          'aria-sort': state.sortKey === column.key ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none',
          onclick: () => handlers.onSort(column.key),
        },
        el('span', { text: column.label }),
        state.sortKey === column.key
          ? el('span', { class: 'sort-caret', 'aria-hidden': 'true', text: state.sortDir === 'asc' ? ' ▲' : ' ▼' })
          : null,
      ),
    ),
  );

  const body = el(
    'tbody',
    {},
    ...rows.map((row) =>
      el(
        'tr',
        {},
        ...COLUMNS.map((column) => {
          const value = cellValue(row, column);
          const text = formatCell(value, column.kind);

          if (column.kind === 'symbol') {
            return el(
              'th',
              { scope: 'row' },
              el('button', {
                class: 'symbol-link',
                type: 'button',
                text: row.symbol,
                onclick: () => handlers.onSelectSymbol(row.symbol),
              }),
            );
          }
          if (column.kind === 'basis') {
            return el('td', { style: { textAlign: 'left' } }, el('span', { class: 'tag', text: row.scoring_basis }));
          }
          if (column.kind === 'score' || column.kind === 'pillar') {
            return el('td', {
              text,
              style: { color: scoreTone(value), fontWeight: column.kind === 'score' ? '700' : '600' },
            });
          }
          return el('td', { text, style: column.align === 'left' ? { textAlign: 'left' } : null });
        }),
      ),
    ),
  );

  render(
    node,
    el(
      'div',
      { class: 'card-head' },
      el('h3', { class: 'card-title', text: 'Screener' }),
      el('span', {
        class: 'card-sub',
        style: { marginBottom: 0 },
        text: `${rows.length} of ${data.total} securities · scored from the warehouse`,
      }),
    ),
    el(
      'div',
      { class: 'filter-row', style: { marginBottom: '14px' } },
      el(
        'div',
        { class: 'filter-group' },
        el('span', { class: 'filter-label', text: 'Basis' }),
        el(
          'div',
          { class: 'segmented' },
          ...[
            ['all', 'All'],
            ['standard', 'Operating'],
            ['reit', 'REITs'],
          ].map(([value, label]) =>
            el('button', {
              type: 'button',
              text: label,
              'aria-pressed': String(state.basis === value),
              onclick: () => handlers.onFilter({ basis: value }),
            }),
          ),
        ),
      ),
      el(
        'div',
        { class: 'filter-group' },
        el('span', { class: 'filter-label', text: 'Sector' }),
        el(
          'select',
          {
            class: 'picker',
            style: { maxWidth: '220px' },
            'aria-label': 'Filter by sector',
            onchange: (event) => handlers.onFilter({ sector: event.target.value }),
          },
          el('option', { value: 'all', selected: state.sector === 'all', text: 'All sectors' }),
          ...data.sectors.map((sector) =>
            el('option', { value: sector, selected: state.sector === sector, text: sector }),
          ),
        ),
      ),
    ),
    el('div', { class: 'table-scroll screener-scroll' }, el('table', { class: 'data screener' }, el('thead', {}, header), body)),
    el('p', {
      class: 'card-sub',
      style: { marginTop: '12px', marginBottom: 0 },
      text:
        'REIT rows are priced on P/FFO and operating companies on P/E — the column shows whichever applies. ' +
        'Scores are screening heuristics, not investment advice.',
    }),
  );
}
