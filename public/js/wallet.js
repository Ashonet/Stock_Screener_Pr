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
import { areaChart, columnChart, cssVar } from './charts.js';
import {
  ARROW,
  DASH,
  compact,
  currency,
  currencySymbol,
  dateTime,
  direction,
  isoDate,
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
        ? data.startReason === 'purchase'
          ? `Series starts ${shortDate(data.startedAt)}, your earliest purchase date. Share counts are held at today's throughout, so this values the basket you hold now rather than replaying what you bought when.`
          : `Series starts ${shortDate(data.startedAt)}, the earliest date every holding has a price for.`
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
  // A native date field rather than a text box: it gets the platform's own
  // picker and locale, and it cannot be typed into in the wrong order.
  const boughtInput = el('input', {
    type: 'date',
    class: 'field field-date',
    max: new Date().toISOString().slice(0, 10),
    value: existing?.boughtAt ?? '',
    title: 'Purchase date, used to attribute dividend income',
    'aria-label': 'Purchase date (optional)',
  });
  const error = el('p', { class: 'form-error', hidden: true });

  const submit = () => {
    const symbol = symbolInput.value.trim().toUpperCase();
    const shares = Number(sharesInput.value);
    const cost = costInput.value.trim() === '' ? null : Number(costInput.value);
    const boughtAt = boughtInput.value.trim() || null;

    if (!/^[A-Z0-9.^=-]{1,20}$/.test(symbol)) return fail('Enter a valid ticker.');
    if (!Number.isFinite(shares) || shares <= 0) return fail('Shares must be a positive number.');
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) return fail('Cost must be zero or more.');
    if (boughtAt && boughtAt > new Date().toISOString().slice(0, 10)) return fail('The purchase date cannot be in the future.');

    error.hidden = true;
    if (existing) handlers.onUpdateHolding(wallet.id, symbol, { shares, cost, boughtAt });
    else handlers.onAddHolding(wallet.id, { symbol, shares, cost, boughtAt });
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
    boughtInput,
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
            { colspan: '10', style: { textAlign: 'left' } },
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
        el('td', { class: row.boughtAt ? null : 'muted', text: row.boughtAt ? isoDate(row.boughtAt) : 'Not set' }),
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
            ...['Symbol', 'Shares', 'Price', 'Day', 'Value', 'Weight', 'Cost / share', 'Gain', 'Bought', ''].map((label) =>
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

/* ----------------------------------------------------------------- income */

/** `2026-03` -> `Mar 26`, short enough to sit under a column without turning. */
function monthLabel(key) {
  const [year, month] = key.split('-');
  const name = new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleDateString(undefined, {
    month: 'short',
    timeZone: 'UTC',
  });
  return `${name} ${year.slice(2)}`;
}

const EXCLUSION_COPY = {
  'no-purchase-date': 'no purchase date set',
  'no-dividend-record': 'no dividend record',
  'none-since-purchase': 'nothing paid since you bought',
};

/**
 * What the wallet has actually been paid, by month and by payment.
 *
 * Every figure rests on two approximations, and both are stated on the card
 * rather than buried: dates are ex-dividend dates (cash settles a few weeks
 * later), and the share count is today's applied back to the purchase date,
 * because the wallet holds a position rather than a ledger of lots.
 */
function renderIncome(node, chartNode, wallet, data, income, mountChart) {
  const code = data?.currency ?? 'USD';
  const unit = currencySymbol(code);
  node.hidden = false;

  const head = (extra) =>
    el(
      'div',
      { class: 'card-head' },
      el('h3', { class: 'card-title', text: 'Dividend income' }),
      extra ? el('span', { class: 'card-sub', style: { marginBottom: 0 }, text: extra }) : null,
    );

  if (!income) {
    render(node, head(), el('p', { class: 'empty', text: 'Working out what this wallet has been paid.' }));
    clear(chartNode);
    chartNode.hidden = true;
    return;
  }

  const { payments = [], months = [], bySymbol = [], totals = {}, excluded = [] } = income;

  // Naming what was left out is the point: a total that quietly skips half the
  // wallet is worse than one that says which half.
  const notes = excluded.length
    ? el(
        'p',
        { class: 'card-sub', style: { marginBottom: 0 } },
        'Not counted: ',
        ...excluded.flatMap((entry, i) => [
          i ? ', ' : '',
          el('strong', { text: entry.symbol }),
          ` (${EXCLUSION_COPY[entry.reason] ?? entry.reason})`,
        ]),
        excluded.some((entry) => entry.reason === 'no-purchase-date')
          ? '. Set a purchase date on a holding and its payments are counted from that date on.'
          : '',
      )
    : null;

  if (!payments.length) {
    render(
      node,
      head(),
      el('p', {
        class: 'empty',
        text: 'No dividends recorded yet. Income counts from each holding’s purchase date onwards.',
      }),
      notes,
    );
    clear(chartNode);
    chartNode.hidden = true;
    return;
  }

  /* ------------------------------------------------------------ summary */

  const stat = (label, value, hint) =>
    el(
      'div',
      { class: 'income-stat' },
      el('span', { class: 'income-stat-label', text: label }),
      el('span', { class: 'income-stat-value', text: value }),
      hint ? el('span', { class: 'income-stat-hint', text: hint }) : null,
    );

  const summary = el(
    'div',
    { class: 'income-summary' },
    stat(
      'Total received',
      currency(totals.total, code),
      `${totals.paymentCount} payments from ${totals.symbolCount} holding${totals.symbolCount === 1 ? '' : 's'}`,
    ),
    stat('Last 12 months', currency(totals.trailingYear, code)),
    stat('Monthly average', totals.monthlyAverage == null ? DASH : currency(totals.monthlyAverage, code), 'completed months only'),
    stat(
      'Best month',
      totals.bestMonth ? currency(totals.bestMonth.amount, code) : DASH,
      totals.bestMonth ? monthLabel(totals.bestMonth.month) : null,
    ),
  );

  render(node, head(totals.firstExDate ? `since ${isoDate(totals.firstExDate)}` : null), summary, notes);

  /* -------------------------------------------------------------- chart */

  // One series in one unit, so no legend box; the title says what is plotted.
  chartNode.hidden = false;
  const colour = cssVar('--series-1');
  mountChart(chartNode, {
    title: 'Income by month',
    subtitle: `${months.length} months, including the ones that paid nothing`,
    height: 300,
    draw: (width, height) =>
      columnChart(width, height, {
        categories: months.map((m) => ({ label: monthLabel(m.month) })),
        series: [{ key: 'income', name: 'Dividend income', color: colour, values: months.map((m) => m.amount) }],
        formatValue: (v) => `${unit}${compact(v)}`,
        ariaLabel: `Dividend income by month for ${wallet.name}`,
      }),
    note:
      'Dates are ex-dividend dates, the boundary that decides who receives a payment; cash usually settles two to four weeks later. ' +
      'Amounts apply the shares you hold today back to each purchase date, so a position you topped up reads high for the months before the top-up.',
    table: {
      columns: ['Month', 'Income'],
      rows: [...months].reverse().map((m) => [monthLabel(m.month), currency(m.amount, code)]),
    },
  });

  /* ------------------------------------------------- per holding + ledger */

  const perSymbol = el(
    'table',
    { class: 'data' },
    el(
      'thead',
      {},
      el('tr', {}, ...['Symbol', 'Payments', 'First', 'Latest', 'Received'].map((label) => el('th', { scope: 'col', text: label }))),
    ),
    el(
      'tbody',
      {},
      ...bySymbol.map((row) =>
        el(
          'tr',
          {},
          el('th', { scope: 'row', text: row.symbol }),
          el('td', { text: String(row.payments) }),
          el('td', { text: isoDate(row.firstExDate) }),
          el('td', { text: isoDate(row.lastExDate) }),
          el('td', { text: currency(row.amount, code) }),
        ),
      ),
    ),
  );

  const ledger = el(
    'table',
    { class: 'data' },
    el(
      'thead',
      {},
      el('tr', {}, ...['Ex-date', 'Symbol', 'Per share', 'Shares', 'Payment'].map((label) => el('th', { scope: 'col', text: label }))),
    ),
    el(
      'tbody',
      {},
      ...payments.map((payment) =>
        el(
          'tr',
          {},
          el('th', { scope: 'row', text: isoDate(payment.exDate) }),
          el('td', { text: payment.symbol }),
          el('td', { text: currency(payment.perShare, code, { digits: 4 }) }),
          el('td', { text: ratio(payment.shares, { digits: payment.shares % 1 === 0 ? 0 : 4 }) }),
          el('td', { text: currency(payment.amount, code) }),
        ),
      ),
    ),
  );

  node.append(
    el(
      'div',
      { class: 'income-tables' },
      el('div', {}, el('h4', { class: 'stats-title', text: 'By holding' }), el('div', { class: 'table-scroll' }, perSymbol)),
      el(
        'div',
        {},
        el('h4', { class: 'stats-title', text: `Every payment (${payments.length})` }),
        el('div', { class: 'table-scroll income-ledger' }, ledger),
      ),
    ),
  );
}

/* --------------------------------------------------------------- forecast */

const FORECAST_EXCLUSION_COPY = {
  'no-dividend-record': 'does not pay a dividend',
  'nothing-paid-in-the-last-year': 'has paid nothing in the last year',
};

/**
 * Projected income, each holding grown at its own five-year dividend CAGR.
 *
 * The caveats are not a footnote here, they are the feature. A five-year growth
 * rate describes the years a company chose to raise in; it cannot see a cut,
 * and a cut is exactly when an income forecast would matter. So the card leads
 * with what the projection assumes rather than burying it under the total.
 */
function renderForecast(node, chartNode, wallet, data, income, mountChart) {
  const code = data?.currency ?? 'USD';
  const unit = currencySymbol(code);

  const head = (extra) =>
    el(
      'div',
      { class: 'card-head' },
      el('h3', { class: 'card-title', text: 'Income forecast' }),
      extra ? el('span', { class: 'card-sub', style: { marginBottom: 0 }, text: extra }) : null,
    );

  const projection = income?.projection;
  if (!projection) {
    render(node, head(), el('p', { class: 'empty', text: 'Working out what this wallet is on track to pay.' }));
    clear(chartNode);
    chartNode.hidden = true;
    return;
  }

  const { rows = [], byYear = [], totals = {}, excluded = [], years = 5 } = projection;
  node.hidden = false;

  const notes = excluded.length
    ? el(
        'p',
        { class: 'card-sub', style: { marginBottom: 0 } },
        'Not projected: ',
        ...excluded.flatMap((entry, i) => [
          i ? ', ' : '',
          el('strong', { text: entry.symbol }),
          ` (${FORECAST_EXCLUSION_COPY[entry.reason] ?? entry.reason})`,
        ]),
      )
    : null;

  if (!rows.length) {
    render(
      node,
      head(),
      el('p', { class: 'empty', text: 'Nothing in this wallet has paid a dividend in the last year, so there is nothing to grow forward.' }),
      notes,
    );
    clear(chartNode);
    chartNode.hidden = true;
    return;
  }

  const stat = (label, value, hint) =>
    el(
      'div',
      { class: 'income-stat' },
      el('span', { class: 'income-stat-label', text: label }),
      el('span', { class: 'income-stat-value', text: value }),
      hint ? el('span', { class: 'income-stat-hint', text: hint }) : null,
    );

  const growthText = totals.blendedGrowth == null ? DASH : `${totals.blendedGrowth > 0 ? '+' : ''}${percent(totals.blendedGrowth, { digits: 1 })}`;

  const summary = el(
    'div',
    { class: 'income-summary' },
    stat('Paying now', currency(totals.currentAnnual, code), 'last twelve months'),
    stat(`In ${years} years`, currency(totals.finalYear, code), 'if growth continues'),
    stat('Blended growth', growthText, 'weighted by income paid'),
    stat(
      'On a measured rate',
      totals.ratedShare == null ? DASH : percent(totals.ratedShare, { digits: 0 }),
      'of projected income',
    ),
  );

  render(node, head(`${rows.length} paying holding${rows.length === 1 ? '' : 's'}`), summary, notes);

  /* -------------------------------------------------------------- chart */

  chartNode.hidden = false;
  const colour = cssVar('--series-1');
  const categories = [{ label: 'Now' }, ...byYear.map((y) => ({ label: `+${y.year}y` }))];
  const values = [totals.currentAnnual, ...byYear.map((y) => y.amount)];

  mountChart(chartNode, {
    title: 'Projected annual income',
    subtitle: `today's holdings, each grown at its own five-year dividend CAGR`,
    height: 300,
    draw: (width, height) =>
      columnChart(width, height, {
        categories,
        series: [{ key: 'income', name: 'Projected annual income', color: colour, values }],
        formatValue: (v) => `${unit}${compact(v)}`,
        ariaLabel: `Projected annual dividend income for ${wallet.name}`,
      }),
    note:
      'A five-year CAGR describes the years a company chose to raise in. It cannot see a cut, and a cut is when this would matter most. ' +
      'Share counts are held at today, nothing is reinvested, and tax is ignored. Read it as "if nothing changes".',
    table: {
      columns: ['Year', 'Projected income'],
      rows: categories.map((c, i) => [c.label, currency(values[i], code)]),
    },
  });

  /* ------------------------------------------------------- per holding */

  const table = el(
    'table',
    { class: 'data' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        ...['Symbol', 'Shares', 'Per share (TTM)', 'Paying now', 'Growth', `In ${years}y`].map((label) =>
          el('th', { scope: 'col', text: label }),
        ),
      ),
    ),
    el(
      'tbody',
      {},
      ...rows.map((row) =>
        el(
          'tr',
          {},
          el('th', { scope: 'row', text: row.symbol }),
          el('td', { text: ratio(row.shares, { digits: row.shares % 1 === 0 ? 0 : 4 }) }),
          el('td', { text: currency(row.perShareTrailing, code, { digits: 4 }) }),
          el('td', { text: currency(row.currentAnnual, code) }),
          el(
            'td',
            {},
            row.growthPct == null
              ? el('abbr', {
                  class: 'muted',
                  title: `Under two years of dividend record, so this holding is projected flat rather than at a guessed rate.`,
                  text: 'flat',
                })
              : el(
                  'abbr',
                  {
                    class: row.fastGrowth ? 'thin-marker-host' : null,
                    title: row.fastGrowth
                      ? `Measured over ${row.yearsOfGrowth} years, but a rate this high comes off a young or very small dividend and will not hold for five. Shown as measured rather than capped, but do not plan on it.`
                      : `Measured over ${row.yearsOfGrowth} year${row.yearsOfGrowth === 1 ? '' : 's'} of rolling dividend totals.`,
                  },
                  `${row.growthPct > 0 ? '+' : ''}${percent(row.growthPct, { digits: 1 })}${row.fastGrowth ? ' !' : ''}`,
                ),
          ),
          el('td', { text: currency(row.projected.at(-1).amount, code) }),
        ),
      ),
    ),
  );

  node.append(
    el('div', { style: { marginTop: '20px' } }, el('h4', { class: 'stats-title', text: 'By holding' }), el('div', { class: 'table-scroll' }, table)),
  );
}

/* --------------------------------------------------------------------- api */

/** The income panel's own empty state, so the tab is never blank. */
function renderIncomeEmpty(node, message, title = 'Dividend income') {
  if (!node) return;
  node.hidden = false;
  render(
    node,
    el('div', { class: 'card-head' }, el('h3', { class: 'card-title', text: title })),
    el('p', { class: 'empty', text: message }),
  );
}

/** Empty *and* out of the layout: a cleared card still paints its own border. */
function hide(node) {
  if (!node) return;
  clear(node);
  node.hidden = true;
}

export function renderWallet({ nodes, wallet, data, income, rangeBlurb, handlers, editing, mountChart }) {
  if (!wallet) {
    render(nodes.hero, el('p', { class: 'empty', text: 'Create a wallet from the sidebar to track a portfolio.' }));
    clear(nodes.chart);
    clear(nodes.holdings);
    hide(nodes.income);
    hide(nodes.incomeChart);
    hide(nodes.forecast);
    hide(nodes.forecastChart);
    return;

  }

  renderHero(nodes.hero, wallet, data, handlers);

  if (!wallet.holdings.length) {
    clear(nodes.chart);
    renderIncomeEmpty(nodes.income, 'Add a holding with a purchase date and its dividends are counted here.');
    hide(nodes.incomeChart);
    renderIncomeEmpty(nodes.forecast, 'Add a dividend-paying holding to project its income forward.', 'Income forecast');
    hide(nodes.forecastChart);
    renderHoldings(nodes.holdings, wallet, data, handlers, editing);
    return;
  }

  renderChart(nodes.chart, wallet, data, rangeBlurb, mountChart);
  renderHoldings(nodes.holdings, wallet, data, handlers, editing);
  renderIncome(nodes.income, nodes.incomeChart, wallet, data, income, mountChart);
  renderForecast(nodes.forecast, nodes.forecastChart, wallet, data, income, mountChart);
}
