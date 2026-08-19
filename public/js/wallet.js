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
import { areaChart, columnChart, donutChart, sparkline, cssVar } from './charts.js';
import { sliceLayout, groupByFacet } from './pie.js';
import { buildGoal, timeWeightedReturn, buildContributionPlan } from './goal.js';
import {
  ARROW,
  DASH,
  compact,
  compactCurrency,
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

/** Score colour, matching the company view's ladder. */
function scoreTone(score) {
  if (!Number.isFinite(score)) return 'var(--text-muted)';
  if (score >= 75) return 'var(--up)';
  if (score >= 60) return 'var(--series-1)';
  if (score >= 45) return 'var(--series-2)';
  return 'var(--down)';
}

/* --------------------------------------------------------------------- hero */

/**
 * The middle of the hero: what the wallet has been doing, and what moved today.
 *
 * The card is a wide two-column grid, so on any normal screen there was a lot
 * of empty between the value and the facts. Filling it with decoration would be
 * worse than leaving it blank, so this is the two things a reader actually
 * looks for next after the total: the shape of the line, and which holding is
 * responsible for today.
 */
function heroTrend(data, income, rangeBlurb) {
  const code = data?.currency ?? 'USD';
  const points = data?.points ?? [];
  const rows = (data?.holdings ?? []).filter((row) => Number.isFinite(row.changePercent));

  const parts = [];

  if (points.length >= 2) {
    const first = points[0].c;
    const last = points.at(-1).c;
    const change = first ? ((last - first) / first) * 100 : null;
    const dir = direction(change);
    const colour = dir === 'down' ? cssVar('--down') : dir === 'up' ? cssVar('--up') : cssVar('--series-1');

    parts.push(
      el(
        'div',
        { class: 'hero-trend-chart' },
        // No axes and no interaction: this is the shape, and the chart on the
        // tab below is the one you read values off.
        sparkline(
          points.map((point) => point.c),
          { width: 220, height: 52, color: colour },
        ),
        el(
          'div',
          { class: 'hero-trend-caption' },
          el('span', { class: 'fact-label', text: rangeBlurb || 'this range' }),
          change == null ? null : delta(change, signedPercent(change)),
        ),
      ),
    );
  }

  // Best and worst today. On a two-holding wallet these are the whole story,
  // and on a twenty-holding one they are the only two rows worth surfacing
  // before the reader opens the table.
  if (rows.length >= 2) {
    const sorted = [...rows].sort((a, b) => b.changePercent - a.changePercent);
    const movers = [
      ['Best today', sorted[0]],
      ['Worst today', sorted.at(-1)],
    ];
    parts.push(
      el(
        'div',
        { class: 'hero-movers' },
        ...movers.map(([label, row]) =>
          el(
            'div',
            { class: 'hero-mover' },
            el('span', { class: 'fact-label', text: label }),
            el('span', { class: 'hero-mover-symbol', text: row.symbol }),
            delta(row.changePercent, signedPercent(row.changePercent)),
          ),
        ),
      ),
    );
  }

  // Forward income, where the wallet has any. The yield is on today's value
  // rather than on cost, since that is what the money is earning now.
  const annual = income?.projection?.totals?.currentAnnual ?? null;
  const value = data?.totals?.value ?? null;
  if (annual > 0) {
    parts.push(
      el(
        'div',
        { class: 'hero-mover' },
        el('span', { class: 'fact-label', text: 'Income a year' }),
        el('span', { class: 'hero-mover-symbol', text: currency(annual, code) }),
        value > 0 ? el('span', { class: 'muted', text: `${percent((annual / value) * 100, { digits: 2 })} yield` }) : null,
      ),
    );
  }

  return parts.length ? el('div', { class: 'hero-trend' }, ...parts) : null;
}

function renderHero(node, wallet, data, handlers, score, income, rangeBlurb) {
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
    // Weighted by position value, not averaged across holdings: the score is
    // what the money is invested in, so a 200 dollar position should not
    // outvote a 60,000 dollar one.
    [
      'Avg score',
      score?.current
        ? el(
            'span',
            {},
            el('span', { style: { color: scoreTone(score.current.score) }, text: Math.round(score.current.score) }),
            score.current.coverage < 99.5
              ? el('span', { class: 'muted', text: ` · ${Math.round(score.current.coverage)}% rated` })
              : null,
          )
        : null,
    ],
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

  render(node, left, heroTrend(data, income, rangeBlurb), right);

  const warnings = [];
  if (data?.unpriced?.length) warnings.push(`No price data for ${data.unpriced.join(', ')}, excluded from the totals.`);
  if (data?.mixedCurrency) warnings.push('Holdings are quoted in more than one currency; values are summed as reported, without conversion.');
  for (const text of warnings) {
    node.append(el('div', { class: 'banner', style: { gridColumn: '1 / -1' }, text }));
  }
}

/* -------------------------------------------------------------------- chart */

/**
 * What the line is and is not.
 *
 * Each holding joins on its purchase date, so the line steps when one is added
 * and that step is money paid in rather than performance. Saying so is the
 * difference between a value chart and a return chart, and only one of them is
 * being drawn.
 */
function seriesNote(data) {
  const start =
    data.startReason === 'purchase'
      ? `Starts ${shortDate(data.startedAt)}, your earliest purchase date.`
      : `Starts ${shortDate(data.startedAt)}, the earliest date every holding has a price for.`;

  const added = (data.contributions ?? []).length;
  const steps = added
    ? ` The line steps up on ${added === 1 ? 'the date a later holding was' : `${added} dates as later holdings were`} added, which is money paid in rather than a gain.`
    : '';

  // The remaining approximation, stated where it is now the only one left.
  const counts = " Share counts are today's throughout, so topping a position up reads back through the whole period it was held.";

  return start + steps + counts;
}

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
    note: !intraday && data.startedAt ? seriesNote(data) : null,
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
function renderForecast(node, chartNode, wallet, data, income, mountChart, handlers, requestedYears) {
  const code = data?.currency ?? 'USD';
  const unit = currencySymbol(code);
  // The horizon the control shows is the one asked for, not the one the last
  // response happened to carry, so the buttons do not flick back while a new
  // projection is in flight.
  const years = requestedYears ?? income?.projection?.years ?? 5;

  /**
   * How far out to project.
   *
   * Presets for the horizons people actually think in, and a box for anything
   * else. Committed on change and on blur rather than per keystroke, so typing
   * "12" does not fire a request for 1 on the way.
   */
  const horizon = () => {
    const input = el('input', {
      type: 'number',
      class: 'field forecast-years',
      min: '1',
      max: '30',
      step: '1',
      value: String(years),
      'aria-label': 'Years to project',
      title: 'Between 1 and 30 years',
      onchange: (event) => commit(event.target.value),
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commit(event.target.value);
      },
    });

    const commit = (raw) => {
      const next = Math.min(30, Math.max(1, Math.round(Number(raw))));
      if (!Number.isFinite(next) || next === years) {
        input.value = String(years);
        return;
      }
      handlers.onForecastYears(next);
    };

    return el(
      'div',
      { class: 'forecast-horizon' },
      el(
        'div',
        { class: 'segmented' },
        ...[3, 5, 10, 20].map((n) =>
          el('button', {
            type: 'button',
            text: `${n}y`,
            'aria-pressed': String(n === years),
            onclick: () => n !== years && handlers.onForecastYears(n),
          }),
        ),
      ),
      input,
      el('span', { class: 'card-sub', style: { marginBottom: 0 }, text: 'years' }),
    );
  };

  const head = (extra) =>
    el(
      'div',
      { class: 'card-head' },
      el('h3', { class: 'card-title', text: 'Income forecast' }),
      extra ? el('span', { class: 'card-sub', style: { marginBottom: 0 }, text: extra }) : null,
      horizon(),
    );

  const projection = income?.projection;
  if (!projection) {
    render(node, head(), el('p', { class: 'empty', text: 'Working out what this wallet is on track to pay.' }));
    clear(chartNode);
    chartNode.hidden = true;
    return;
  }

  const { rows = [], byYear = [], totals = {}, excluded = [] } = projection;
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

  const assumptions = el(
    'details',
    { class: 'forecast-assumptions' },
    el('summary', { text: 'What this assumes' }),
    el('p', {
      text:
        'Each holding grows at its own dividend CAGR, measured over up to five years of rolling twelve-month totals. ' +
        'That rate describes the years a company chose to raise in, so it cannot see a cut, and a cut is when a forecast like this would matter most. ' +
        'Share counts are held at today, nothing is reinvested, and tax is ignored.',
    }),
  );

  render(node, head(`${rows.length} paying holding${rows.length === 1 ? '' : 's'}`), summary, notes, assumptions);

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

/* ------------------------------------------------------------------- goal */

/**
 * How much capital the wanted income needs, and how much of it has to be sold.
 *
 * The withdrawal rate is a control rather than a constant because it is the
 * assumption doing all the work: at 3% a 30,000 income needs a million, at 4%
 * it needs 750,000. Fixing it silently would hide the single number the whole
 * page rests on.
 */
function renderGoal(node, chartNode, wallet, data, income, mountChart, handlers, goalState) {
  const code = data?.currency ?? 'USD';
  const unit = currencySymbol(code);
  const { target, rate } = goalState;

  const field = (opts) =>
    el('input', {
      type: 'number',
      class: 'field goal-field',
      min: opts.min,
      max: opts.max,
      step: opts.step,
      value: String(opts.value),
      'aria-label': opts.label,
      title: opts.title,
      onchange: (event) => opts.commit(event.target.value),
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        opts.commit(event.target.value);
      },
    });

  const controls = el(
    'div',
    { class: 'goal-controls' },
    el(
      'label',
      { class: 'goal-control' },
      el('span', { class: 'income-stat-label', text: `Income wanted (${unit}/year)` }),
      field({
        value: target,
        min: '0',
        step: '500',
        label: 'Annual income wanted',
        title: 'The income you want the portfolio to pay each year',
        commit: (raw) => handlers.onGoalTarget(Number(raw)),
      }),
    ),
    el(
      'label',
      { class: 'goal-control' },
      el('span', { class: 'income-stat-label', text: 'Withdrawal rate (%)' }),
      field({
        value: rate,
        min: '0.5',
        max: '10',
        step: '0.1',
        label: 'Annual withdrawal rate',
        title: 'The share of the portfolio drawn each year. This is the assumption the whole page rests on.',
        commit: (raw) => handlers.onGoalRate(Number(raw)),
      }),
    ),
    el(
      'label',
      { class: 'goal-control' },
      el('span', { class: 'income-stat-label', text: 'Years to get there' }),
      field({
        value: goalState.years,
        min: '1',
        max: '50',
        step: '1',
        label: 'Years to reach the goal',
        title: 'Between 1 and 50 years',
        commit: (raw) => handlers.onGoalYears(Number(raw)),
      }),
    ),
  );

  const head = el(
    'div',
    { class: 'card-head' },
    el('h3', { class: 'card-title', text: 'Income goal' }),
    el('span', { class: 'card-sub', style: { marginBottom: 0 }, text: `drawn at ${rate}% a year` }),
  );

  const goal = buildGoal({
    value: data?.totals?.value,
    annualDividends: income?.projection?.totals?.currentAnnual ?? 0,
    target,
    withdrawalRate: rate,
    startValue: data?.points?.[0]?.c ?? null,
    startedAt: data?.startedAt ?? null,
    dividendsReceived: income?.totals?.total ?? null,
    contributions: (data?.contributions ?? []).length,
  });

  node.hidden = false;

  if (!goal.ok) {
    const why = {
      'no-value': 'This wallet has no value yet, so there is nothing to measure a goal against.',
      'no-target': 'Set the income you want and this works out what the portfolio has to be worth.',
      'no-rate': 'The withdrawal rate has to be above zero.',
    };
    render(node, head, controls, el('p', { class: 'empty', text: why[goal.reason] ?? 'Not enough to work with yet.' }));
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

  const summary = el(
    'div',
    { class: 'income-summary' },
    stat('Portfolio needed', currency(goal.requiredValue, code), `to draw ${currency(goal.target, code)} a year`),
    stat('Portfolio now', currency(goal.value, code), `${percent(goal.progressPct, { digits: 1 })} of the way`),
    stat('Still to go', currency(goal.shortfall, code)),
    stat('Current yield', percent(goal.yieldPct, { digits: 2 }), `${currency(goal.annualDividends, code)} a year`),
  );

  // Progress reads as a proportion, so it gets a bar as well as a number.
  const bar = el(
    'div',
    { class: 'goal-progress' },
    el(
      'div',
      { class: 'goal-track', role: 'img', 'aria-label': `${Math.round(goal.progressPct)}% of the way to the goal` },
      el('div', { class: 'goal-fill', style: { width: `${Math.max(0.5, goal.progressPct)}%` } }),
    ),
    el(
      'div',
      { class: 'goal-scale' },
      el('span', { text: currency(0, code) }),
      el('span', { text: currency(goal.requiredValue, code) }),
    ),
  );

  render(node, head, controls, summary, bar);

  /* ------------------------------------------- where the withdrawal comes from */

  const splitRow = (label, s, portfolio) =>
    el(
      'tr',
      {},
      el('th', { scope: 'row', text: label }),
      el('td', { text: currency(portfolio, code) }),
      el('td', { text: currency(s.withdrawal, code) }),
      el('td', { text: currency(s.fromDividends, code) }),
      el('td', {}, s.fromSales > 0 ? currency(s.fromSales, code) : el('span', { class: 'muted', text: 'nothing' })),
      el('td', { text: `${percent(s.saleRatePct, { digits: 2 })}` }),
    );

  const splitTable = el(
    'table',
    { class: 'data' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        ...['', 'Portfolio', `Drawn at ${rate}%`, 'From dividends', 'From selling', 'Sold per year'].map((label) =>
          el('th', { scope: 'col', text: label }),
        ),
      ),
    ),
    el('tbody', {}, splitRow('Today', goal.today, goal.value), splitRow('At the goal', goal.atTarget, goal.requiredValue)),
  );

  node.append(
    el(
      'div',
      { style: { marginTop: '20px' } },
      el('h4', { class: 'stats-title', text: 'Where the income comes from' }),
      el('div', { class: 'table-scroll' }, splitTable),
    ),
  );

  /* ------------------------------------------------- what it takes to get there */

  // The wallet's own return, chain-linked so the money paid in when a holding
  // joined is not counted as growth. Price only, since the value series is
  // built from closes, which is exactly what the reinvestment comparison needs:
  // one case adds the yield back, the other does not.
  const twr = timeWeightedReturn(data?.points ?? [], (data?.contributions ?? []).map((c) => c.t));
  // An override is read as a total return, so the no-reinvestment case takes
  // the yield back off it.
  const priceReturn = goalState.returnPct != null ? goalState.returnPct - goal.yieldPct : twr.annualisedPct;

  const plan =
    priceReturn == null
      ? null
      : buildContributionPlan({
          value: goal.value,
          requiredValue: goal.requiredValue,
          years: goalState.years,
          priceReturnPct: priceReturn,
          yieldPct: goal.yieldPct,
        });

  const planBody = () => {
    if (!plan) {
      return el('p', {
        class: 'empty',
        text:
          twr.years == null
            ? 'Not enough price history in this wallet to measure a return, so there is nothing to project a plan from yet.'
            : `Held ${twr.years.toFixed(1)} years so far. A year of history is needed before a rate can be annualised, so there is nothing to project a plan from yet.`,
      });
    }

    const money = (v) => currency(v, code);
    const row = (label, scenario, hint) =>
      el(
        'tr',
        {},
        el('th', { scope: 'row' }, label, el('div', { class: 'card-sub', style: { margin: 0 }, text: hint })),
        el('td', { text: percent(scenario.annualReturnPct, { digits: 1 }) }),
        el(
          'td',
          {},
          scenario.alreadyThere ? el('span', { class: 'muted', text: 'nothing needed' }) : money(scenario.perMonth),
        ),
        el(
          'td',
          {},
          scenario.alreadyThere ? el('span', { class: 'muted', text: 'nothing needed' }) : money(scenario.perYear),
        ),
        el('td', { text: money(scenario.futureValueOfCurrent) }),
      );

    const table = el(
      'table',
      { class: 'data' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          ...['Dividends', 'Growth a year', 'Per month', 'Per year', `Current grows to`].map((label) =>
            el('th', { scope: 'col', text: label }),
          ),
        ),
      ),
      el(
        'tbody',
        {},
        row('Reinvested', plan.reinvested, 'price growth plus the yield'),
        row('Taken as cash', plan.spent, 'price growth alone'),
      ),
    );

    return el('div', {}, el('div', { class: 'table-scroll' }, table));
  };

  node.append(
    el(
      'div',
      { style: { marginTop: '20px' } },
      el('h4', { class: 'stats-title', text: `Getting there in ${goalState.years} year${goalState.years === 1 ? '' : 's'}` }),
      planBody(),
    ),
  );

  /* ------------------------------------------------- since the first purchase */

  const since = goal.sinceStart;
  if (since.startValue != null) {
    const sinceTable = el(
      'table',
      { class: 'data' },
      el(
        'thead',
        {},
        el('tr', {}, ...['', 'At first purchase', 'Now', 'Needed'].map((label) => el('th', { scope: 'col', text: label }))),
      ),
      el(
        'tbody',
        {},
        el(
          'tr',
          {},
          el('th', { scope: 'row', text: 'Portfolio value' }),
          el('td', { text: currency(since.startValue, code) }),
          el('td', { text: currency(goal.value, code) }),
          el('td', { text: currency(goal.requiredValue, code) }),
        ),
        el(
          'tr',
          {},
          el('th', { scope: 'row', text: 'Dividends a year' }),
          el('td', { class: 'muted', text: since.dividendsReceived == null ? DASH : `${currency(since.dividendsReceived, code)} received since` }),
          el('td', { text: currency(goal.annualDividends, code) }),
          el('td', { text: currency(goal.atTarget.fromDividends, code) }),
        ),
      ),
    );

    node.append(
      el(
        'div',
        { style: { marginTop: '20px' } },
        el('h4', { class: 'stats-title', text: 'Since your first purchase' }),
        el('div', { class: 'table-scroll' }, sinceTable),
      ),
    );
  }

  node.append(
    el(
      'details',
      { class: 'forecast-assumptions' },
      el('summary', { text: 'What this assumes' }),
      el('p', {
        text:
          `A portfolio drawn at ${rate}% a year supports ${rate}% of its value in income, so the target needs ${currency(goal.requiredValue, code)} of capital. ` +
          'Dividends are not income on top of that withdrawal, they are the part of it that arrives without selling, and the gap between the yield and the rate is what has to be sold. ' +
          "Today's yield is assumed to hold as the portfolio grows, which is the weakest part: a portfolio that grows mostly on price ends up yielding less and would need to sell more than this shows. " +
          'The contribution plan assumes the wallet keeps earning what it has earned so far, measured over a period short enough that it may not mean much, and that every payment is made on time and never missed. ' +
          'Reinvesting is assumed to happen at no cost and with nothing lost to tax, which favours it slightly over the cash case in reality. ' +
          'Nothing here accounts for inflation, tax or a dividend being cut. In real terms a target fixed today buys less in thirty years than it does now.',
      }),
    ),
  );

  /* ------------------------------------------------------------------ chart */

  const points = data?.points ?? [];
  if (points.length < 2) {
    clear(chartNode);
    chartNode.hidden = true;
    return;
  }

  chartNode.hidden = false;
  const colour = cssVar('--series-1');
  mountChart(chartNode, {
    title: 'Value against the goal',
    subtitle: `since ${shortDate(data.startedAt)}, with the ${currency(goal.requiredValue, code)} needed marked`,
    height: 320,
    draw: (width, height) =>
      areaChart(width, height, {
        points,
        color: colour,
        ariaLabel: `${wallet.name} value against the goal`,
        formatValue: (v) => `${unit}${compact(v)}`,
        // The scale stretches to include the goal, which is the point: it shows
        // the distance rather than filling the plot with the near ground.
        referenceValue: goal.requiredValue,
        referenceLabel: 'goal',
        endLabel: currency(goal.value, code),
        formatTooltip: (point) => [
          shortDate(point.t),
          [
            { label: 'Portfolio value', value: currency(point.c, code), color: colour },
            { label: 'Of the goal', value: percent((point.c / goal.requiredValue) * 100, { digits: 1 }) },
          ],
        ],
      }),
    table: {
      columns: ['Date', 'Value', 'Of the goal'],
      rows: [...points]
        .reverse()
        .map((p) => [shortDate(p.t), currency(p.c, code), percent((p.c / goal.requiredValue) * 100, { digits: 1 })]),
    },
  });
}

/* --------------------------------------------------------- quality over time */

/**
 * The wallet's weighted quality score, and how it got there.
 *
 * Three things move this line and the model keeps them apart: a company
 * reporting a new year, a holding's weight drifting with its price, and a
 * holding joining on the day it was bought. The last is what makes it the
 * portfolio's score rather than a watchlist average, and it is why the line
 * steps when a purchase lands.
 */
function renderScoreTab(node, chartNode, wallet, data, score, mountChart) {
  const code = data?.currency ?? 'USD';

  const head = (extra) =>
    el(
      'div',
      { class: 'card-head' },
      el('h3', { class: 'card-title', text: 'Quality over time' }),
      extra ? el('span', { class: 'card-sub', style: { marginBottom: 0 }, text: extra }) : null,
    );

  if (!score) {
    render(node, head(), el('p', { class: 'empty', text: 'Working out what this wallet has held.' }));
    clear(chartNode);
    chartNode.hidden = true;
    return;
  }

  node.hidden = false;
  const { points = [], holdings = [], current = null, excluded = [] } = score;

  const notes = excluded.length
    ? el(
        'p',
        { class: 'card-sub', style: { marginBottom: 0 } },
        'Not scored: ',
        ...excluded.flatMap((entry, i) => [i ? ', ' : '', el('strong', { text: entry.symbol }), ` (${entry.reason})`]),
        '. Only companies in the tracked universe carry a grade, and an ungraded holding is left out of the score rather than counted as zero.',
      )
    : null;

  if (!current || points.length < 2) {
    render(
      node,
      head(),
      el('p', {
        class: 'empty',
        text: 'Nothing in this wallet has a grade yet, so there is no portfolio score to plot.',
      }),
      notes,
    );
    clear(chartNode);
    chartNode.hidden = true;
    return;
  }

  const first = points[0].c;
  const last = points.at(-1).c;
  const move = last - first;

  const stat = (label, value, hint) =>
    el(
      'div',
      { class: 'income-stat' },
      el('span', { class: 'income-stat-label', text: label }),
      el('span', { class: 'income-stat-value', text: value }),
      hint ? el('span', { class: 'income-stat-hint', text: hint }) : null,
    );

  render(
    node,
    head(`since ${shortDate(points[0].t)}`),
    el(
      'div',
      { class: 'income-summary' },
      stat('Score now', String(Math.round(current.score)), 'weighted by position value'),
      stat('At the start', String(Math.round(first)), shortDate(points[0].t)),
      stat('Change', `${move > 0 ? '+' : ''}${move.toFixed(1)}`, 'points'),
      stat('Rated', `${Math.round(current.coverage)}%`, `${current.gradedHoldings} of ${wallet.holdings.length} holdings`),
    ),
    notes,
  );

  /* -------------------------------------------------------------- chart */

  const colour = cssVar('--series-1');
  chartNode.hidden = false;
  mountChart(chartNode, {
    title: 'Weighted quality score',
    subtitle: 'each holding counted from the day it was bought, weighted by what it was worth',
    height: 300,
    draw: (width, height) =>
      areaChart(width, height, {
        points,
        color: colour,
        ariaLabel: `${wallet.name} weighted quality score over time`,
        formatValue: (v) => v.toFixed(0),
        endLabel: String(Math.round(last)),
        formatTooltip: (point) => [
          shortDate(point.t),
          [
            { label: 'Portfolio score', value: point.c.toFixed(1), color: colour },
            point.coverage != null && point.coverage < 99.5
              ? { label: 'Of value rated', value: `${Math.round(point.coverage)}%` }
              : null,
          ].filter(Boolean),
        ],
      }),
    table: {
      columns: ['Date', 'Score', 'Rated'],
      rows: [...points].reverse().map((p) => [shortDate(p.t), p.c.toFixed(1), `${Math.round(p.coverage ?? 100)}%`]),
    },
  });

  /* -------------------------------------------------------- composition */

  const table = el(
    'table',
    { class: 'data' },
    el(
      'thead',
      {},
      el('tr', {}, ...['Symbol', 'Score', 'Grade', 'Value', 'Weight', 'Graded on'].map((label) => el('th', { scope: 'col', text: label }))),
    ),
    el(
      'tbody',
      {},
      ...holdings.map((row) =>
        el(
          'tr',
          {},
          el('th', { scope: 'row', text: row.symbol }),
          el('td', { style: { color: scoreTone(row.score) }, text: String(row.score) }),
          el('td', { text: row.grade ?? DASH }),
          el('td', { text: currency(row.value, code) }),
          el(
            'td',
            {},
            el(
              'div',
              { class: 'weight-cell' },
              el('span', { text: percent(row.weight, { digits: 1 }) }),
              el('span', { class: 'weight-track', 'aria-hidden': 'true' }, el('span', { class: 'weight-fill', style: { width: `${row.weight}%` } })),
            ),
          ),
          el('td', { text: isoDate(row.asOf) }),
        ),
      ),
    ),
  );

  node.append(
    el(
      'div',
      { style: { marginTop: '20px' } },
      el('h4', { class: 'stats-title', text: 'What makes up the score' }),
      el('div', { class: 'table-scroll' }, table),
      el(
        'details',
        { class: 'forecast-assumptions' },
        el('summary', { text: 'How this is worked out' }),
        el('p', {
          text:
            'Each holding carries the grade of the last financial year that had closed at the time, so no grade is applied before the statements behind it existed. ' +
            'Those grades are recomputed from the statements on file rather than recorded at the time, which means a later restatement is included in them. ' +
            'The weighting is by position value at each point, so the line moves when a company reports, when prices shift the weights, and when a purchase adds a holding.',
        }),
      ),
    ),
  );
}

/* -------------------------------------------------------------- breakdown */

/**
 * What the wallet is actually made of, on whichever facet is asked for.
 *
 * Concentration is the thing worth seeing here and it is easy to miss in a
 * holdings table sorted by value: three positions can look like a diversified
 * portfolio and turn out to be one sector. The donut answers "how much of this
 * is one thing" at a glance, which is the one question a pie chart is good at.
 */
const MIX_FACETS = [
  ['symbol', 'Holding'],
  ['sector', 'Sector'],
  ['industry', 'Industry'],
  ['grade', 'Quality grade'],
  ['basis', 'Type'],
  ['country', 'Country'],
];

/** Categorical slots, capped at what stays distinguishable. */
const MIX_COLOURS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];

function renderMix(node, wallet, data, facets, state, handlers, mountChart) {
  const code = data?.currency ?? 'USD';
  const rows = data?.holdings ?? [];

  const picker = el(
    'div',
    { class: 'segmented' },
    ...MIX_FACETS.map(([key, label]) =>
      el('button', {
        type: 'button',
        text: label,
        'aria-pressed': String(state.facet === key),
        onclick: () => key !== state.facet && handlers.onMixFacet(key),
      }),
    ),
  );

  const head = el(
    'div',
    { class: 'card-head' },
    el('h3', { class: 'card-title', text: 'Breakdown' }),
    el('span', { class: 'card-sub', style: { marginBottom: 0 }, text: `${rows.length} holdings` }),
  );

  if (!rows.length || !rows.some((row) => row.value > 0)) {
    render(node, head, picker, el('p', { class: 'empty', text: 'Nothing priced in this wallet yet.' }));
    return;
  }

  // Facets other than the ticker need the reference data. Until it lands the
  // picker still works, it just has one option that can answer.
  const facetOf = (row) => {
    if (state.facet === 'symbol') return row.symbol;
    const fact = facets?.facets?.[row.symbol];
    if (!fact) return null;
    if (state.facet === 'basis') return fact.isReit ? 'REIT' : 'Operating company';
    return fact[state.facet] ?? null;
  };

  const enriched = rows
    .filter((row) => Number.isFinite(row.value) && row.value > 0)
    .map((row) => ({ symbol: row.symbol, value: row.value, facet: facetOf(row) }));

  const groups = groupByFacet(enriched, 'facet', { maxSlices: MIX_COLOURS.length });
  const { slices, total } = sliceLayout(groups);
  const coloured = slices.map((slice, i) => ({ ...slice, color: cssVar(MIX_COLOURS[i % MIX_COLOURS.length]) }));

  const unresolved = enriched.filter((row) => row.facet == null).length;
  const facetLabel = MIX_FACETS.find(([key]) => key === state.facet)?.[1] ?? state.facet;

  render(
    node,
    head,
    picker,
    facets && !facets.available && state.facet !== 'symbol'
      ? el('p', {
          class: 'banner-inline',
          text: 'The warehouse has not been built, so only the per-holding split is available.',
        })
      : null,
  );

  mountChart(node.appendChild(el('div', {})), {
    title: `By ${facetLabel.toLowerCase()}`,
    subtitle:
      `${currency(total, code)} across ${coloured.length} ${coloured.length === 1 ? 'slice' : 'slices'}` +
      (coloured[0] ? ` · largest is ${coloured[0].label} at ${percent(coloured[0].share, { digits: 1 })}` : ''),
    height: 340,
    legend: coloured.map((slice) => ({ name: `${slice.label} · ${percent(slice.share, { digits: 1 })}`, color: slice.color })),
    draw: (width, height) =>
      donutChart(width, height, {
        slices: coloured,
        total,
        formatValue: (v) => currency(v, code),
        centreValue: compactCurrency(total, code),
        centreLabel: 'total',
        ariaLabel: `Wallet split by ${facetLabel.toLowerCase()}`,
      }),
    note:
      unresolved > 0
        ? `${unresolved} holding${unresolved === 1 ? '' : 's'} could not be classified and ${unresolved === 1 ? 'is' : 'are'} grouped as Unclassified. Only companies in the tracked universe carry reference data.`
        : null,
    table: {
      columns: [facetLabel, 'Value', 'Share', 'Holdings'],
      rows: coloured.map((slice) => [
        slice.folded ? `${slice.label} (${slice.folded} more)` : slice.label,
        currency(slice.value, code),
        percent(slice.share, { digits: 1 }),
        slice.members.map((m) => m.symbol).join(', '),
      ]),
    },
  });

  // A folded tail is only honest if the reader can see what went into it.
  const folded = coloured.find((slice) => slice.folded);
  if (folded) {
    node.append(
      el('p', {
        class: 'card-sub',
        style: { marginTop: '12px', marginBottom: 0 },
        text: `"Other" holds ${folded.foldedLabels.join(', ')}. The palette carries six colours that stay distinguishable from one another, so the tail is folded rather than drawn in shades nobody can match to a legend.`,
      }),
    );
  }
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

export function renderWallet({ nodes, wallet, data, income, score, facets, mix, rangeBlurb, handlers, editing, mountChart, forecastYears, goal }) {
  if (!wallet) {
    render(nodes.hero, el('p', { class: 'empty', text: 'Create a wallet from the sidebar to track a portfolio.' }));
    clear(nodes.chart);
    clear(nodes.holdings);
    hide(nodes.income);
    hide(nodes.incomeChart);
    hide(nodes.forecast);
    hide(nodes.forecastChart);
    hide(nodes.goal);
    hide(nodes.goalChart);
    hide(nodes.score);
    hide(nodes.scoreChart);
    hide(nodes.mix);
    return;

  }

  renderHero(nodes.hero, wallet, data, handlers, score, income, rangeBlurb);

  if (!wallet.holdings.length) {
    clear(nodes.chart);
    renderIncomeEmpty(nodes.income, 'Add a holding with a purchase date and its dividends are counted here.');
    hide(nodes.incomeChart);
    renderIncomeEmpty(nodes.forecast, 'Add a dividend-paying holding to project its income forward.', 'Income forecast');
    hide(nodes.forecastChart);
    renderIncomeEmpty(nodes.goal, 'Add a holding and this works out what the portfolio has to be worth.', 'Income goal');
    hide(nodes.goalChart);
    renderIncomeEmpty(nodes.score, 'Add a holding and its quality grade is tracked here.', 'Quality over time');
    hide(nodes.scoreChart);
    renderIncomeEmpty(nodes.mix, 'Add a holding to see what this wallet is made of.', 'Breakdown');
    renderHoldings(nodes.holdings, wallet, data, handlers, editing);
    return;
  }

  renderChart(nodes.chart, wallet, data, rangeBlurb, mountChart);
  renderHoldings(nodes.holdings, wallet, data, handlers, editing);
  renderIncome(nodes.income, nodes.incomeChart, wallet, data, income, mountChart);
  renderForecast(nodes.forecast, nodes.forecastChart, wallet, data, income, mountChart, handlers, forecastYears);
  renderGoal(nodes.goal, nodes.goalChart, wallet, data, income, mountChart, handlers, goal);
  renderScoreTab(nodes.score, nodes.scoreChart, wallet, data, score, mountChart);
  renderMix(nodes.mix, wallet, data, facets, mix, handlers, mountChart);
}
