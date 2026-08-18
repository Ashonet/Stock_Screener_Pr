/**
 * Wallet view: a portfolio's value over time, its totals, and an editable
 * holdings table.
 *
 * The value chart holds share counts fixed at what the wallet contains today,
 * so it answers "what has this basket been worth?" rather than replaying a
 * transaction ledger. The subtitle says so, the two are easy to conflate and
 * only one of them is what the numbers mean.
 */

import { el, render, clear } from './dom.js';
import { areaChart, cssVar } from './charts.js';
import {
  ARROW,
  DASH,
  compact,
  currency,
  currencySymbol,
  dateTime,
  direction,
  percent,
  ratio,
  shortDate,
} from './format.js';

const signedPercent = (v) => (v == null ? DASH : `${v > 0 ? '+' : ''}${percent(v)}`);
const signedMoney = (v, code) => (v == null ? DASH : `${v > 0 ? '+' : ''}${currency(v, code)}`);

/** Signed figure with an arrow, so direction never rests on color alone. */
function delta(value, text) {
  const dir = direction(value);
  return el(
    'span',
    { class: `delta-${dir}` },
    el('span', { class: 'delta-arrow', 'aria-hidden': 'true', text: ARROW[dir] }),
    ' ',
    text,
  );
}

/* --------------------------------------------------------------------- hero */

function renderHero(node, wallet, data, handlers) {
  const code = data?.currency ?? 'USD';
  const totals = data?.totals ?? {};

  const actions = el(
    'div',
    { class: 'wallet-actions' },
    el('button', {
      class: 'link-button',
      type: 'button',
      text: 'Rename',
      onclick: () => handlers.onRename(wallet),
    }),
    el('button', {
      class: 'link-button',
      type: 'button',
      text: 'Delete',
      onclick: () => handlers.onDelete(wallet),
    }),
  );

  const left = el(
    'div',
    {},
    el(
      'div',
      { class: 'hero-id' },
      el('span', { class: 'hero-symbol', text: wallet.name }),
      el('span', { class: 'tag', text: `${wallet.holdings.length} ${wallet.holdings.length === 1 ? 'holding' : 'holdings'}` }),
    ),
    el('div', { class: 'hero-price', text: totals.value == null ? DASH : currency(totals.value, code) }),
    el(
      'div',
      { class: 'hero-delta' },
      delta(
        totals.dayChange,
        `${signedMoney(totals.dayChange, code)} (${signedPercent(totals.dayChangePercent)})`,
      ),
      el('span', { class: 'delta-flat', style: { fontWeight: '400', fontSize: '13px' }, text: 'today' }),
    ),
  );

  const facts = [
    ['Total cost', totals.costTotal == null ? null : currency(totals.costTotal, code)],
    [
      'Total gain',
      totals.gain == null
        ? null
        : delta(totals.gain, `${signedMoney(totals.gain, code)} (${signedPercent(totals.gainPercent)})`),
    ],
  ].filter(([, value]) => value);

  const right = el(
    'div',
    { class: 'hero-side' },
    actions,
    facts.length
      ? el(
          'div',
          { class: 'hero-facts' },
          ...facts.map(([label, value]) =>
            el(
              'div',
              {},
              el('div', { class: 'fact-label', text: label }),
              el('div', { class: 'fact-value' }, value),
            ),
          ),
        )
      : null,
    // A wallet where only some rows have a cost basis would otherwise report a
    // gain that silently covers part of the portfolio.
    totals.costCoverage != null && totals.costCoverage > 0 && totals.costCoverage < 1
      ? el('p', {
          class: 'card-sub',
          style: { marginBottom: 0 },
          text: `Gain covers only the holdings with a cost basis (${Math.round(totals.costCoverage * 100)}% of them).`,
        })
      : null,
  );

  render(node, left, right);

  const warnings = [];
  if (data?.unpriced?.length) warnings.push(`No price data for ${data.unpriced.join(', ')}, excluded from the totals.`);
  if (data?.mixedCurrency) warnings.push('Holdings are quoted in more than one currency; values are summed as reported, without conversion.');
  for (const text of warnings) {
    node.append(el('div', { class: 'banner', style: { gridColumn: '1 / -1' }, text }));
  }
}

/* -------------------------------------------------------------------- chart */

function renderChart(node, wallet, data, rangeBlurb, mountChart) {
  const points = data?.points ?? [];
  const code = data?.currency ?? 'USD';

  if (points.length < 2) {
    render(
      node,
      el('div', { class: 'card-head' }, el('h3', { class: 'card-title', text: 'Wallet value' })),
      el('p', { class: 'empty', text: 'Not enough overlapping price history to chart this wallet.' }),
    );
    return;
  }

  const first = points[0].c;
  const last = points.at(-1).c;
  const change = last - first;
  const changePct = first ? (change / first) * 100 : null;
  const dir = direction(change);
  const color = dir === 'down' ? cssVar('--down') : dir === 'up' ? cssVar('--up') : cssVar('--series-1');
  const symbol = currencySymbol(code);
  const intraday = data.range === '1d' || data.range === '5d';

  mountChart(node, {
    title: 'Wallet value',
    subtitle:
      `${rangeBlurb} · value of the ${wallet.holdings.length} holdings you hold today, at historical prices` +
      (changePct != null ? ` · ${signedPercent(changePct)} over the period` : ''),
    height: 320,
    draw: (width, height) =>
      areaChart(width, height, {
        points,
        color,
        ariaLabel: `${wallet.name} value over the selected range`,
        formatValue: (v) => `${symbol}${compact(v)}`,
        endLabel: currency(last, code),
        formatTooltip: (point) => [
          intraday ? dateTime(point.t) : shortDate(point.t),
          [
            { label: 'Wallet value', value: currency(point.c, code), color },
            first ? { label: 'From period start', value: signedPercent(((point.c - first) / first) * 100) } : null,
          ].filter(Boolean),
        ],
      }),
    note:
      data.startedAt && !intraday
        ? `Series starts ${shortDate(data.startedAt)}, the earliest date every holding has a price for.`
        : null,
    table: {
      columns: ['Date', 'Value'],
      rows: [...points].reverse().map((p) => [intraday ? dateTime(p.t) : shortDate(p.t), currency(p.c, code)]),
    },
  });
}

/* ----------------------------------------------------------------- holdings */

function holdingForm(wallet, handlers, { existing = null, onDone } = {}) {
  const symbolInput = el('input', {
    type: 'text',
    class: 'field',
    placeholder: 'Ticker',
    value: existing?.symbol ?? '',
    readonly: Boolean(existing),
    'aria-label': 'Ticker',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const sharesInput = el('input', {
    type: 'number',
    class: 'field',
    placeholder: 'Shares',
    step: 'any',
    min: '0',
    value: existing?.shares ?? '',
    'aria-label': 'Number of shares',
  });
  const costInput = el('input', {
    type: 'number',
    class: 'field',
    placeholder: 'Cost / share',
    step: 'any',
    min: '0',
    value: existing?.cost ?? '',
    'aria-label': 'Cost per share (optional)',
  });
  const error = el('p', { class: 'form-error', hidden: true });

  const submit = () => {
    const symbol = symbolInput.value.trim().toUpperCase();
    const shares = Number(sharesInput.value);
    const cost = costInput.value.trim() === '' ? null : Number(costInput.value);

    if (!/^[A-Z0-9.^=-]{1,20}$/.test(symbol)) return fail('Enter a valid ticker.');
    if (!Number.isFinite(shares) || shares <= 0) return fail('Shares must be a positive number.');
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) return fail('Cost must be zero or more.');

    error.hidden = true;
    if (existing) handlers.onUpdateHolding(wallet.id, symbol, { shares, cost });
    else handlers.onAddHolding(wallet.id, { symbol, shares, cost });
    onDone?.();
  };

  function fail(message) {
    error.textContent = message;
    error.hidden = false;
  }

  const form = el(
    'form',
    {
      class: 'holding-form',
      onsubmit: (event) => {
        event.preventDefault();
        submit();
      },
    },
    symbolInput,
    sharesInput,
    costInput,
    el('button', { class: 'primary-button', type: 'submit', text: existing ? 'Save' : 'Add' }),
    onDone ? el('button', { class: 'link-button', type: 'button', text: 'Cancel', onclick: () => onDone() }) : null,
    error,
  );

  return form;
}

function renderHoldings(node, wallet, data, handlers, editing) {
  const code = data?.currency ?? 'USD';
  const rows = data?.holdings ?? [];

  const head = el(
    'div',
    { class: 'card-head' },
    el('h3', { class: 'card-title', text: 'Holdings' }),
    el('span', { class: 'card-sub', style: { marginBottom: 0 }, text: `${wallet.holdings.length} positions` }),
  );

  if (!wallet.holdings.length) {
    render(
      node,
      head,
      el('p', { class: 'empty', text: 'This wallet is empty. Add your first holding below.' }),
      holdingForm(wallet, handlers),
    );
    return;
  }

  const body = el('tbody', {});
  for (const row of rows) {
    if (editing === row.symbol) {
      body.append(
        el(
          'tr',
          {},
          el(
            'td',
            { colspan: '8', style: { textAlign: 'left' } },
            holdingForm(wallet, handlers, {
              existing: wallet.holdings.find((h) => h.symbol === row.symbol),
              onDone: () => handlers.onEdit(null),
            }),
          ),
        ),
      );
      continue;
    }

    body.append(
      el(
        'tr',
        {},
        el(
          'th',
          { scope: 'row' },
          el('button', {
            class: 'symbol-link',
            type: 'button',
            text: row.symbol,
            title: row.name,
            onclick: () => handlers.onSelectSymbol(row.symbol),
          }),
        ),
        el('td', { text: ratio(row.shares, { digits: row.shares % 1 === 0 ? 0 : 4 }) }),
        el('td', { text: row.price == null ? DASH : currency(row.price, code) }),
        el('td', {}, delta(row.changePercent, signedPercent(row.changePercent))),
        el('td', { text: row.value == null ? DASH : currency(row.value, code) }),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'weight-cell' },
            el('span', { text: row.weight == null ? DASH : percent(row.weight, { digits: 1 }) }),
            // One series, one color, bar length already carries the value.
            el(
              'span',
              { class: 'weight-track', 'aria-hidden': 'true' },
              el('span', { class: 'weight-fill', style: { width: `${row.weight ?? 0}%` } }),
            ),
          ),
        ),
        el('td', { text: row.cost == null ? DASH : currency(row.cost, code) }),
        el('td', {}, row.gain == null ? DASH : delta(row.gain, `${signedMoney(row.gain, code)} (${signedPercent(row.gainPercent)})`)),
        el(
          'td',
          {},
          el(
            'span',
            { class: 'row-actions' },
            el('button', {
              class: 'link-button',
              type: 'button',
              text: 'Edit',
              'aria-label': `Edit ${row.symbol}`,
              onclick: () => handlers.onEdit(row.symbol),
            }),
            el('button', {
              class: 'link-button',
              type: 'button',
              text: '×',
              'aria-label': `Remove ${row.symbol}`,
              onclick: () => handlers.onRemoveHolding(wallet.id, row.symbol),
            }),
          ),
        ),
      ),
    );
  }

  render(
    node,
    head,
    el(
      'div',
      { class: 'table-scroll wallet-table' },
      el(
        'table',
        { class: 'data' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            ...['Symbol', 'Shares', 'Price', 'Day', 'Value', 'Weight', 'Cost / share', 'Gain', ''].map((label) =>
              el('th', { scope: 'col', text: label }),
            ),
          ),
        ),
        body,
      ),
    ),
    el('div', { class: 'add-holding' }, el('h4', { class: 'stats-title', text: 'Add a holding' }), holdingForm(wallet, handlers)),
  );
}

/* --------------------------------------------------------------------- api */

export function renderWallet({ nodes, wallet, data, rangeBlurb, handlers, editing, mountChart }) {
  if (!wallet) {
    render(nodes.hero, el('p', { class: 'empty', text: 'Create a wallet from the sidebar to track a portfolio.' }));
    clear(nodes.chart);
    clear(nodes.holdings);
    return;
  }

  renderHero(nodes.hero, wallet, data, handlers);

  if (!wallet.holdings.length) {
    clear(nodes.chart);
    renderHoldings(nodes.holdings, wallet, data, handlers, editing);
    return;
  }

  renderChart(nodes.chart, wallet, data, rangeBlurb, mountChart);
  renderHoldings(nodes.holdings, wallet, data, handlers, editing);
}
