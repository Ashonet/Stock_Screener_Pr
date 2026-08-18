/** Dashboard state, data loading and rendering. */

import { el, render, clear, debounce } from './dom.js';
import * as api from './api.js';
import {
  store,
  loadStore,
  activeList,
  activeWallet,
  createList,
  renameList,
  deleteList,
  addToList,
  removeFromList,
  createWallet,
  renameWallet,
  deleteWallet,
  upsertHolding,
  updateHolding,
  removeHolding,
  holdingsParam,
  saveLists,
  saveWallets,
  saveView,
  SYMBOL_PATTERN,
} from './store.js';
import { renderWallet } from './wallet.js';
import { renderCompare } from './compare.js';
import { renderScreener } from './screener.js';
import { renderMap } from './map.js';
import { chartCard, areaChart, columnChart, sparkline, dataTable, cssVar, hideTooltip } from './charts.js';
import {
  ARROW,
  DASH,
  clockTime,
  compact,
  compactCurrency,
  currency,
  currencySymbol,
  dateTime,
  direction,
  integer,
  isoDate,
  metricValue,
  percent,
  ratio,
  shortDate,
} from './format.js';

/* ----------------------------------------------------------------- constants */

const RANGES = [
  { key: '1d', label: '1D', blurb: 'Today, 5-minute bars' },
  { key: '5d', label: '5D', blurb: 'Five sessions, 30-minute bars' },
  { key: '1mo', label: '1M', blurb: 'One month of daily closes' },
  { key: '6mo', label: '6M', blurb: 'Six months of daily closes' },
  { key: 'ytd', label: 'YTD', blurb: 'Year to date, daily closes' },
  { key: '1y', label: '1Y', blurb: 'One year of daily closes' },
  { key: '5y', label: '5Y', blurb: 'Five years of weekly closes' },
  { key: 'max', label: 'MAX', blurb: 'Full history, monthly closes' },
];

const PERIODS = [
  { key: 'annual', label: 'Annual' },
  { key: 'quarterly', label: 'Quarterly' },
];

const STORE = {
  theme: 'sd:theme',
  range: 'sd:range',
  symbol: 'sd:active',
  tab: 'sd:tab',
  walletTab: 'sd:walletTab',
  historyPeriod: 'sd:historyPeriod',
  forecastYears: 'sd:forecastYears',
  goalTarget: 'sd:goalTarget',
  goalRate: 'sd:goalRate',
  goalYears: 'sd:goalYears',
  goalReturn: 'sd:goalReturn',
  period: 'sd:period',
};
const REFRESH_MS = 30_000;

/**
 * The three sections under the filter row. `repaint` re-renders a panel's
 * charts on the way in: a chart measures its container to size itself, and a
 * hidden panel measures zero, so anything drawn while the tab was closed would
 * otherwise come back at its minimum width.
 */
/**
 * The wallet's two sections. Same `repaint` reason as the company tabs: the
 * income chart sizes itself from its container, and a container inside a
 * hidden panel measures zero.
 */
const WALLET_TABS = [
  { id: 'overview', label: 'Value and holdings' },
  { id: 'income', label: 'Dividend income' },
  { id: 'forecast', label: 'Income forecast' },
  { id: 'goal', label: 'Goal' },
];

const TABS = [
  { id: 'stats', label: 'Key stats' },
  {
    id: 'financials',
    label: 'Financials',
    repaint: () => {
      if (!state.stock) return;
      renderFinancials(state.stock);
      renderDividends(state.stock);
      renderIncomeStatement(state.stock);
    },
  },
  { id: 'score', label: 'Quality score' },
];

/* --------------------------------------------------------------------- state */

const readStore = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const writeStore = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing, the dashboard still works, it just forgets */
  }
};

// Watchlists and wallets live in store.js; this holds the per-session view state.
loadStore();

const state = {
  active: readStore(STORE.symbol, null),
  range: readStore(STORE.range, '1y'),
  tab: readStore(STORE.tab, 'stats'),
  walletTab: readStore(STORE.walletTab, 'overview'),
  historyPeriod: readStore(STORE.historyPeriod, 'annual'),
  forecastYears: readStore(STORE.forecastYears, 5),
  // The withdrawal rate defaults to 3%, which is the convention the tab is
  // built around, but it is state rather than a constant because it is the
  // assumption the whole page rests on.
  goal: {
    target: readStore(STORE.goalTarget, 30_000),
    rate: readStore(STORE.goalRate, 3),
    years: readStore(STORE.goalYears, 20),
    // Null means "use the rate this wallet has actually earned". Only set
    // once someone overrides it.
    returnPct: readStore(STORE.goalReturn, null),
  },
  period: readStore(STORE.period, 'annual'),
  stock: null,
  quotes: new Map(),
  sparks: new Map(),
  walletData: null,
  walletIncome: null,
  screenerData: null,
  screener: { sortKey: 'overall_score', sortDir: 'desc', basis: 'all', sector: 'all' },
  mapData: null,
  map: { mode: 'change' },
  compareData: null,
  compare: { symbols: [], years: 10, mode: 'total' },
  editingHolding: null,
  loading: false,
  requestToken: 0,
  walletToken: 0,
  compareToken: 0,
};

const symbols = () => activeList()?.symbols ?? [];
// The open company need not be in a list: you can look at something without
// keeping it, and that choice should survive a reload.
if (!state.active || !SYMBOL_PATTERN.test(state.active)) state.active = symbols()[0] ?? null;
if (!RANGES.some((r) => r.key === state.range)) state.range = '1y';
if (!PERIODS.some((p) => p.key === state.period)) state.period = 'annual';

// ?symbol=TSLA opens straight onto a ticker, so a view is linkable.
const linked = new URLSearchParams(location.search).get('symbol');
if (linked && SYMBOL_PATTERN.test(linked)) {
  // Opens the company without saving it. A shared link should not silently
  // edit the recipient's watchlist, the hero carries an explicit control for
  // keeping it.
  state.active = linked.toUpperCase();
  store.view = 'stock';
}

const dom = {
  marketStrip: document.getElementById('market-strip'),
  watchlist: document.getElementById('watchlist'),
  watchlistCount: document.getElementById('watchlist-count'),
  listPicker: document.getElementById('list-picker'),
  listNew: document.getElementById('list-new'),
  listEdit: document.getElementById('list-edit'),
  listForm: document.getElementById('list-form'),
  navScreener: document.getElementById('nav-screener'),
  navMap: document.getElementById('nav-map'),
  navCompare: document.getElementById('nav-compare'),
  walletIncome: document.getElementById('wallet-income'),
  walletPanels: {
    overview: document.getElementById('wpanel-overview'),
    income: document.getElementById('wpanel-income'),
    forecast: document.getElementById('wpanel-forecast'),
    goal: document.getElementById('wpanel-goal'),
  },
  walletIncomeChart: document.getElementById('wallet-income-chart'),
  walletForecast: document.getElementById('wallet-forecast'),
  walletForecastChart: document.getElementById('wallet-forecast-chart'),
  walletGoal: document.getElementById('wallet-goal'),
  walletGoalChart: document.getElementById('wallet-goal-chart'),
  compareView: document.getElementById('compare-view'),
  compareCard: document.getElementById('compare-card'),
  mapView: document.getElementById('map-view'),
  mapCard: document.getElementById('map-card'),
  screenerCount: document.getElementById('screener-count'),
  screenerView: document.getElementById('screener-view'),
  screenerCard: document.getElementById('screener-card'),
  walletList: document.getElementById('wallet-list'),
  walletNew: document.getElementById('wallet-new'),
  walletForm: document.getElementById('wallet-form'),
  walletView: document.getElementById('wallet-view'),
  walletHero: document.getElementById('wallet-hero'),
  walletRangePicker: document.getElementById('wallet-range-picker'),
  walletChart: document.getElementById('wallet-chart-card'),
  walletHoldings: document.getElementById('wallet-holdings'),
  detail: document.getElementById('detail'),
  hero: document.getElementById('hero'),
  rangePicker: document.getElementById('range-picker'),
  periodPicker: document.getElementById('period-picker'),
  priceCard: document.getElementById('price-card'),
  scoreCard: document.getElementById('score-card'),
  stats: document.getElementById('stats'),
  financialsCard: document.getElementById('financials-card'),
  incomeStatement: document.getElementById('income-statement'),
  dividendCard: document.getElementById('dividend-card'),
  targetCard: document.getElementById('target-card'),
  aboutCard: document.getElementById('about-card'),
  search: document.getElementById('search-input'),
  searchResults: document.getElementById('search-results'),
  refreshStatus: document.getElementById('refresh-status'),
  themeToggle: document.getElementById('theme-toggle'),
};

/** Chart cards install resize observers; drop the old ones before re-rendering. */
const disposers = new Map();
function mountChart(container, config) {
  disposers.get(container)?.();
  disposers.set(container, chartCard(container, config));
}

/* --------------------------------------------------------------- primitives */

/** Signed change with an arrow glyph, so direction never rests on color alone. */
function deltaNode(change, changePercent, code, { size = 'normal', priceRef = null } = {}) {
  const dir = direction(changePercent ?? change);
  const parts = [];
  // Precision follows the price, not the change: a $0.45 move on a $15 stock
  // is two decimals, even though 0.45 on its own would round to four.
  const digits = priceRef == null ? undefined : Math.abs(priceRef) >= 1 ? 2 : 4;
  if (change != null) parts.push(`${change > 0 ? '+' : ''}${currency(change, code, { digits })}`);
  if (changePercent != null) parts.push(`(${changePercent > 0 ? '+' : ''}${percent(changePercent)})`);
  return el(
    'span',
    { class: `delta-${dir}`, style: size === 'small' ? { fontSize: '11.5px' } : null },
    el('span', { class: 'delta-arrow', 'aria-hidden': 'true', text: ARROW[dir] }),
    ' ',
    parts.join(' ') || DASH,
  );
}

function seriesColors() {
  return {
    s1: cssVar('--series-1'),
    s2: cssVar('--series-2'),
    up: cssVar('--up'),
    down: cssVar('--down'),
    muted: cssVar('--text-muted'),
  };
}

/* ------------------------------------------------------------- market strip */

async function loadMarket() {
  try {
    const indices = await api.fetchMarket();
    render(
      dom.marketStrip,
      ...indices.map((index) =>
        el(
          'li',
          { class: 'market-item' },
          el('span', { class: 'market-label', text: index.label }),
          el('span', {
            class: 'market-value',
            text: index.price == null ? DASH : ratio(index.price, { digits: index.symbol === '^TNX' ? 2 : 2 }),
          }),
          deltaNode(null, index.changePercent, 'USD', { size: 'small' }),
        ),
      ),
    );
  } catch {
    render(dom.marketStrip, el('li', { class: 'market-item' }, el('span', { class: 'market-label', text: 'Market data unavailable' })));
  }
}

/* ----------------------------------------------------------------- watchlist */

/** The watchlist picker, kept in step with the stored lists. */
function renderListPicker() {
  render(
    dom.listPicker,
    ...store.lists.map((list) =>
      el('option', { value: list.id, selected: list.id === store.activeListId, text: list.name }),
    ),
  );
}

function renderWatchlist() {
  const list = symbols();
  dom.watchlistCount.textContent = String(list.length);

  if (!list.length) {
    render(dom.watchlist, el('li', { class: 'empty', text: 'No tickers in this list yet.' }));
    return;
  }

  render(
    dom.watchlist,
    ...list.map((symbol) => {
      const quote = state.quotes.get(symbol);
      const dir = direction(quote?.changePercent);
      const color = dir === 'down' ? cssVar('--down') : dir === 'up' ? cssVar('--up') : cssVar('--text-muted');
      const spark = state.sparks.get(symbol);

      const row = el(
        'button',
        {
          class: 'wl-row',
          type: 'button',
          'aria-current': String(symbol === state.active && store.view === 'stock'),
          onclick: () => selectSymbol(symbol),
        },
        el(
          'span',
          {},
          el('div', { class: 'wl-symbol', text: symbol }),
          el('div', { class: 'wl-name', text: quote?.name ?? '' }),
        ),
        spark?.length ? sparkline(spark, { color }) : el('span', { class: 'wl-spark' }),
        el(
          'span',
          { class: 'wl-figures' },
          el('div', { class: 'wl-price', text: quote?.price == null ? DASH : currency(quote.price, quote.currency ?? 'USD') }),
          el(
            'div',
            { class: `wl-change delta-${dir}` },
            el('span', { 'aria-hidden': 'true', text: ARROW[dir] }),
            ' ',
            quote?.changePercent == null ? DASH : percent(quote.changePercent, { signed: true }),
          ),
        ),
      );

      row.append(
        el('span', {
          class: 'wl-remove',
          role: 'button',
          tabindex: '0',
          'aria-label': `Remove ${symbol} from watchlist`,
          text: '×',
          onclick: (event) => {
            event.stopPropagation();
            removeSymbol(symbol);
          },
          onkeydown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            removeSymbol(symbol);
          },
        }),
      );

      return el('li', {}, row);
    }),
  );
}

/** One quote request covers every list and wallet on screen. */
function trackedSymbols() {
  return [...new Set([...symbols(), ...store.wallets.flatMap((w) => w.holdings.map((h) => h.symbol))])];
}

async function loadWatchlistQuotes() {
  const tracked = trackedSymbols();
  if (!tracked.length) return;
  try {
    const quotes = await api.fetchQuotes(tracked);
    for (const quote of quotes) state.quotes.set(quote.symbol, quote);
    renderWatchlist();
    renderWalletList();
    dom.refreshStatus.textContent = `Updated ${clockTime(Date.now())}`;
  } catch {
    dom.refreshStatus.textContent = 'Quotes unavailable';
  }
}

/** Sparklines are a nice-to-have: fetch them lazily and never block on them. */
async function loadSparklines() {
  const missing = symbols().filter((s) => !state.sparks.has(s));
  if (!missing.length) return;

  await Promise.allSettled(
    missing.map(async (symbol) => {
      try {
        const chart = await api.fetchChart(symbol, '1mo');
        // ~30 points is all a 64px sparkline can show.
        const closes = chart.points.map((p) => p.c);
        const stride = Math.max(1, Math.floor(closes.length / 30));
        state.sparks.set(
          symbol,
          closes.filter((_, i) => i % stride === 0),
        );
      } catch {
        state.sparks.set(symbol, []); // remember the failure so we stop retrying
      }
    }),
  );
  renderWatchlist();
}

/**
 * Open a company without committing it to a list.
 *
 * Searching used to add whatever you looked at, so glancing at a ticker left it
 * in your watchlist and the list filled up with things you had merely checked.
 * Looking and keeping are different intentions and now have different actions.
 */
function viewSymbol(symbol) {
  selectSymbol(symbol.toUpperCase());
  loadWatchlistQuotes();
}

/** Keep a symbol in the current watchlist. */
function addTickerToList(symbol) {
  const upper = symbol.trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(upper)) return false;
  addToList(upper);
  renderWatchlist();
  loadWatchlistQuotes();
  loadSparklines();
  if (state.stock?.quote?.symbol === upper) renderHero(state.stock);
  return true;
}

function removeTickerFromList(symbol) {
  removeFromList(symbol);
  state.sparks.delete(symbol);
  renderWatchlist();
  if (state.stock?.quote?.symbol === symbol) renderHero(state.stock);
}

function removeSymbol(symbol) {
  removeFromList(symbol);
  state.sparks.delete(symbol);

  if (state.active === symbol && store.view === 'stock') {
    state.active = symbols()[0] ?? null;
    writeStore(STORE.symbol, state.active);
    if (state.active) loadStock();
    else renderEmptyDetail();
  }
  renderWatchlist();
}

/* --------------------------------------------------------- list management */

/** Inline name form, used for both creating and renaming a list or wallet. */
function nameForm(node, { label, value = '', confirmText, onSubmit, extra = null }) {
  const input = el('input', { type: 'text', class: 'field', value, 'aria-label': label, maxlength: '40', placeholder: label });
  render(
    node,
    el(
      'form',
      {
        onsubmit: (event) => {
          event.preventDefault();
          const name = input.value.trim();
          if (name) onSubmit(name);
          node.hidden = true;
        },
      },
      input,
      el('button', { class: 'primary-button', type: 'submit', text: confirmText }),
      el('button', {
        class: 'link-button',
        type: 'button',
        text: 'Cancel',
        onclick: () => {
          node.hidden = true;
        },
      }),
      extra,
    ),
  );
  node.hidden = false;
  input.focus();
  input.select();
}

function setupLists() {
  dom.listPicker.addEventListener('change', () => {
    store.activeListId = dom.listPicker.value;
    saveLists();
    dom.listForm.hidden = true;
    // Switching lists changes what the sidebar shows, not what you are reading.
    // Only fall back when nothing is open at all.
    if (!state.active) {
      state.active = symbols()[0] ?? null;
      writeStore(STORE.symbol, state.active);
      if (state.active) loadStock();
      else renderEmptyDetail();
    }
    renderWatchlist();
    loadWatchlistQuotes();
    loadSparklines();
  });

  // The + adds a ticker to the list you are looking at. It used to create a
  // whole new list, which is a much rarer thing to want and read as "add" to
  // everyone who tried it.
  dom.listNew.addEventListener('click', () => tickerForm(dom.listForm));

  dom.listEdit.addEventListener('click', () => {
    const list = activeList();
    nameForm(dom.listForm, {
      label: 'List name',
      value: list.name,
      confirmText: 'Rename',
      onSubmit: (name) => {
        renameList(list.id, name);
        renderListPicker();
      },
      // The last list is never deletable, the sidebar always has one.
      extra: [
        el('button', {
          class: 'link-button',
          type: 'button',
          text: 'New list',
          onclick: () => {
            dom.listForm.hidden = true;
            nameForm(dom.listForm, {
              label: 'List name',
              confirmText: 'Create',
              onSubmit: (name) => {
                createList(name);
                renderListPicker();
                renderWatchlist();
              },
            });
          },
        }),
        store.lists.length > 1
          ? el('button', {
              class: 'link-button danger',
              type: 'button',
              text: 'Delete list',
              onclick: () => {
                deleteList(list.id);
                dom.listForm.hidden = true;
                renderListPicker();
                renderWatchlist();
                if (!symbols().includes(state.active)) {
                  state.active = symbols()[0] ?? null;
                  writeStore(STORE.symbol, state.active);
                  if (state.active) loadStock();
                  else renderEmptyDetail();
                }
                loadWatchlistQuotes();
              },
            })
          : null,
      ],
    });
  });
}

/**
 * Add a ticker by typing it, with suggestions.
 *
 * Free text alone would accept anything and fail later with an unhelpful
 * "no data"; the suggestions come from the same lookup the top search uses, so
 * a typo is visible before it is saved.
 */
function tickerForm(node) {
  const input = el('input', {
    type: 'text',
    class: 'field',
    placeholder: 'Add ticker, e.g. TSLA',
    'aria-label': 'Ticker to add',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const suggestions = el('ul', { class: 'ticker-suggestions', hidden: true });
  const error = el('p', { class: 'form-error', hidden: true });

  const close = () => {
    node.hidden = true;
  };

  const commit = (symbol) => {
    if (addTickerToList(symbol)) close();
    else {
      error.textContent = `"${symbol}" is not a valid ticker.`;
      error.hidden = false;
    }
  };

  const lookup = debounce(async (query) => {
    if (query.length < 1) {
      suggestions.hidden = true;
      return;
    }
    try {
      const results = (await api.searchSymbols(query)).slice(0, 6);
      if (!results.length) {
        suggestions.hidden = true;
        return;
      }
      render(
        suggestions,
        ...results.map((r) =>
          el(
            'li',
            {},
            el('button', {
              type: 'button',
              // mousedown, not click: blur would hide the list first.
              onmousedown: (event) => {
                event.preventDefault();
                commit(r.symbol);
              },
              onclick: () => commit(r.symbol),
            },
            el('span', { class: 'result-symbol', text: r.symbol }),
            el('span', { class: 'result-name', text: r.name }),
            ),
          ),
        ),
      );
      suggestions.hidden = false;
    } catch {
      suggestions.hidden = true;
    }
  }, 200);

  input.addEventListener('input', () => {
    error.hidden = true;
    lookup(input.value.trim());
  });

  render(
    node,
    el(
      'form',
      {
        onsubmit: (event) => {
          event.preventDefault();
          commit(input.value);
        },
      },
      input,
      el('button', { class: 'primary-button', type: 'submit', text: 'Add' }),
      el('button', { class: 'link-button', type: 'button', text: 'Cancel', onclick: close }),
      error,
      suggestions,
    ),
  );
  node.hidden = false;
  input.focus();
}

/* ------------------------------------------------------------------ wallets */

/** Sidebar wallet rows, valued from the quotes already on hand. */
function renderWalletList() {
  if (!store.wallets.length) {
    // An empty state that only reports the emptiness leaves the reader hunting
    // for the control; this one is the control.
    render(
      dom.walletList,
      el(
        'li',
        { class: 'empty-state' },
        el('p', { text: 'Track a portfolio’s value, cost basis and gain over time.' }),
        el('button', {
          class: 'primary-button',
          type: 'button',
          text: 'Create a wallet',
          onclick: () =>
            nameForm(dom.walletForm, {
              label: 'Wallet name',
              confirmText: 'Create',
              onSubmit: (name) => {
                const wallet = createWallet(name);
                renderWalletList();
                selectWallet(wallet.id);
              },
            }),
        }),
      ),
    );
    return;
  }

  render(
    dom.walletList,
    ...store.wallets.map((wallet) => {
      // Valuing from the shared quote cache keeps the sidebar live without a
      // portfolio request per wallet.
      let value = null;
      let previous = null;
      for (const holding of wallet.holdings) {
        const quote = state.quotes.get(holding.symbol);
        if (quote?.price == null) continue;
        value = (value ?? 0) + quote.price * holding.shares;
        previous = (previous ?? 0) + (quote.previousClose ?? quote.price) * holding.shares;
      }
      const dayPercent = value != null && previous ? ((value - previous) / previous) * 100 : null;
      const dir = direction(dayPercent);

      return el(
        'li',
        {},
        el(
          'button',
          {
            class: 'wl-row wallet-row',
            type: 'button',
            'aria-current': String(store.view === 'wallet' && wallet.id === store.activeWalletId),
            onclick: () => selectWallet(wallet.id),
          },
          el(
            'span',
            {},
            el('div', { class: 'wl-symbol', text: wallet.name }),
            el('div', {
              class: 'wl-name',
              text: `${wallet.holdings.length} ${wallet.holdings.length === 1 ? 'holding' : 'holdings'}`,
            }),
          ),
          el(
            'span',
            { class: 'wl-figures' },
            el('div', {
              class: 'wl-price',
              text: value == null ? DASH : compactCurrency(value, 'USD'),
            }),
            el(
              'div',
              { class: `wl-change delta-${dir}` },
              el('span', { 'aria-hidden': 'true', text: ARROW[dir] }),
              ' ',
              dayPercent == null ? DASH : percent(dayPercent, { signed: true }),
            ),
          ),
        ),
      );
    }),
  );
}

function setupWallets() {
  dom.walletNew.addEventListener('click', () => {
    nameForm(dom.walletForm, {
      label: 'Wallet name',
      confirmText: 'Create',
      onSubmit: (name) => {
        const wallet = createWallet(name);
        renderWalletList();
        selectWallet(wallet.id);
      },
    });
  });
}

const walletHandlers = {
  onForecastYears: (years) => setForecastYears(years),
  // Both are pure repaints: the goal is worked out in the browser from the
  // valuation and income already in hand, so changing either needs no request.
  onGoalTarget: (value) => setGoal({ target: Math.max(0, Math.round(Number(value) || 0)) }),
  onGoalRate: (value) => setGoal({ rate: Math.min(10, Math.max(0.1, Number(value) || 3)) }),
  onGoalYears: (value) => setGoal({ years: Math.min(50, Math.max(1, Math.round(Number(value) || 20))) }),
  onSelectSymbol: (symbol) => {
    addToList(symbol);
    renderWatchlist();
    selectSymbol(symbol);
  },
  onRename: (wallet) =>
    nameForm(dom.walletForm, {
      label: 'Wallet name',
      value: wallet.name,
      confirmText: 'Rename',
      onSubmit: (name) => {
        renameWallet(wallet.id, name);
        renderWalletList();
        renderWalletView();
      },
    }),
  onDelete: (wallet) => {
    deleteWallet(wallet.id);
    renderWalletList();
    if (store.activeWalletId) selectWallet(store.activeWalletId);
    else {
      showStockView();
      if (state.active) loadStock();
    }
  },
  onAddHolding: (walletId, holding) => {
    upsertHolding(walletId, holding);
    state.editingHolding = null;
    afterWalletEdit();
  },
  onUpdateHolding: (walletId, symbol, changes) => {
    updateHolding(walletId, symbol, changes);
    state.editingHolding = null;
    afterWalletEdit();
  },
  onRemoveHolding: (walletId, symbol) => {
    removeHolding(walletId, symbol);
    state.editingHolding = null;
    afterWalletEdit();
  },
  onEdit: (symbol) => {
    state.editingHolding = symbol;
    renderWalletView();
  },
};

function afterWalletEdit() {
  renderWalletList();
  loadWalletData();
  loadWatchlistQuotes();
}

function renderWalletView() {
  renderWallet({
    nodes: {
      hero: dom.walletHero,
      chart: dom.walletChart,
      holdings: dom.walletHoldings,
      income: dom.walletIncome,
      incomeChart: dom.walletIncomeChart,
      forecast: dom.walletForecast,
      forecastChart: dom.walletForecastChart,
      goal: dom.walletGoal,
      goalChart: dom.walletGoalChart,
    },
    wallet: activeWallet(),
    data: state.walletData,
    income: state.walletIncome,
    forecastYears: state.forecastYears,
    goal: state.goal,
    rangeBlurb: RANGES.find((r) => r.key === state.range)?.blurb ?? '',
    handlers: walletHandlers,
    editing: state.editingHolding,
    mountChart,
  });
}

async function loadWalletData() {
  const wallet = activeWallet();
  if (!wallet || !wallet.holdings.length) {
    state.walletData = null;
    state.walletIncome = null;
    renderWalletView();
    return;
  }

  const token = ++state.walletToken;
  dom.walletView.classList.add('is-loading');
  // Income is a separate request on purpose: it is a per-symbol dividend
  // history and slower than the valuation, so letting it land on its own keeps
  // the value chart from waiting on it.
  loadWalletIncome(wallet, token);
  try {
    const data = await api.fetchPortfolio(holdingsParam(wallet), state.range);
    if (token !== state.walletToken) return;
    state.walletData = data;
    renderWalletView();
  } catch (err) {
    if (token !== state.walletToken) return;
    state.walletData = null;
    renderWalletView();
    render(dom.walletChart, el('p', { class: 'error-note', text: `Could not value this wallet: ${err.message}` }));
  } finally {
    if (token === state.walletToken) dom.walletView.classList.remove('is-loading');
  }
}

/**
 * Re-project over a new horizon.
 *
 * Only the forecast is refetched. The valuation and the received-income record
 * do not depend on how far forward anyone is looking, and reloading them would
 * make the value chart flicker for a change that cannot affect it.
 */
function setGoal(patch) {
  state.goal = { ...state.goal, ...patch };
  writeStore(STORE.goalTarget, state.goal.target);
  writeStore(STORE.goalRate, state.goal.rate);
  writeStore(STORE.goalYears, state.goal.years);
  writeStore(STORE.goalReturn, state.goal.returnPct);
  renderWalletView();
}

function setForecastYears(years) {
  state.forecastYears = years;
  writeStore(STORE.forecastYears, years);
  renderWalletView();
  const wallet = activeWallet();
  if (wallet?.holdings.length) loadWalletIncome(wallet, state.walletToken);
}

async function loadWalletIncome(wallet, token) {
  state.walletIncome = null;
  try {
    const income = await api.fetchIncome(holdingsParam(wallet), state.forecastYears);
    if (token !== state.walletToken) return;
    state.walletIncome = income;
  } catch {
    // A failed income call must not blank the wallet: an empty record renders
    // as "nothing recorded yet", which is the same shape as a genuinely empty
    // one and leaves the valuation above it untouched.
    if (token !== state.walletToken) return;
    state.walletIncome = { payments: [], months: [], bySymbol: [], totals: {}, excluded: [] };
  }
  renderWalletView();
}

function selectWallet(id) {
  store.activeWalletId = id;
  store.view = 'wallet';
  clearSymbolFromUrl();
  state.editingHolding = null;
  state.walletData = null;
  state.walletIncome = null;
  saveWallets();
  saveView();
  setVisibleView('wallet');
  renderWatchlist();
  renderWalletList();
  renderWalletView();
  loadWalletData();
}

function showStockView() {
  store.view = 'stock';
  saveView();
  setVisibleView('stock');
  renderWalletList();
}

/** Exactly one pane visible; the nav highlight follows it. */
function setVisibleView(view) {
  // Optional-chained throughout: a missing pane must not stop the others being
  // shown, or one absent element blanks the whole app.
  if (dom.detail) dom.detail.hidden = view !== 'stock';
  if (dom.walletView) dom.walletView.hidden = view !== 'wallet';
  if (dom.screenerView) dom.screenerView.hidden = view !== 'screener';
  if (dom.mapView) dom.mapView.hidden = view !== 'map';
  if (dom.compareView) dom.compareView.hidden = view !== 'compare';
  dom.navScreener?.setAttribute('aria-current', String(view === 'screener'));
  dom.navMap?.setAttribute('aria-current', String(view === 'map'));
  dom.navCompare?.setAttribute('aria-current', String(view === 'compare'));
}

/* ------------------------------------------------------------------ compare */

function renderCompareView() {
  renderCompare({
    node: dom.compareCard,
    data: state.compareData,
    state: state.compare,
    handlers: {
      onSymbols: (raw) => {
        const symbols = raw
          .split(/[,\s]+/)
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
          .slice(0, 6);
        if (symbols.length < 2) {
          state.compareData = { error: 'Give at least two tickers to compare.' };
          renderCompareView();
          return;
        }
        state.compare.symbols = symbols;
        loadCompare();
      },
      onYears: (years) => {
        state.compare.years = years;
        loadCompare();
      },
      // A mode switch is a repaint of data already in hand, not a refetch:
      // both series come back in the same response.
      onMode: (mode) => {
        state.compare.mode = mode;
        renderCompareView();
      },
    },
  });
}

async function loadCompare() {
  const token = ++state.compareToken;
  state.compareData = null;
  renderCompareView();
  try {
    const data = await api.fetchCompare(state.compare.symbols.join(','), state.compare.years);
    if (token !== state.compareToken) return;
    state.compareData = data;
  } catch (err) {
    if (token !== state.compareToken) return;
    state.compareData = { error: err.message };
  }
  renderCompareView();
}

function showCompareView() {
  store.view = 'compare';
  saveView();
  clearSymbolFromUrl();
  setVisibleView('compare');
  renderWatchlist();
  renderWalletList();
  // Seed from the watchlist the first time, so the view opens with something
  // to look at rather than an empty form.
  if (!state.compare.symbols.length) {
    const seed = (activeList()?.symbols ?? []).slice(0, 4);
    state.compare.symbols = seed.length >= 2 ? seed : ['O', 'KO', 'NVDA', 'UNP'];
  }
  renderCompareView();
  if (!state.compareData) loadCompare();
}

/* --------------------------------------------------------------- market map */

function renderMapView() {
  renderMap({
    node: dom.mapCard,
    data: state.mapData,
    state: state.map,
    handlers: {
      onSelectSymbol: (symbol) => selectSymbol(symbol),
      onMode: (mode) => {
        state.map.mode = mode;
        renderMapView();
      },
    },
  });
}

async function loadMap() {
  try {
    state.mapData = await api.fetchMap();
  } catch (err) {
    state.mapData = { error: err.message };
  }
  renderMapView();
}

function showMapView() {
  store.view = 'map';
  saveView();
  clearSymbolFromUrl();
  setVisibleView('map');
  renderWatchlist();
  renderWalletList();
  renderMapView();
  if (!state.mapData) loadMap();
}

/* ----------------------------------------------------------------- screener */

function renderScreenerView() {
  renderScreener({
    node: dom.screenerCard,
    data: state.screenerData,
    state: state.screener,
    handlers: {
      onSelectSymbol: (symbol) => {
        addToList(symbol);
        renderWatchlist();
        selectSymbol(symbol);
      },
      onSort: (key) => {
        // Clicking the active column flips direction; a new column starts
        // descending, because every metric here is "higher is more interesting".
        if (state.screener.sortKey === key) {
          state.screener.sortDir = state.screener.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.screener.sortKey = key;
          state.screener.sortDir = 'desc';
        }
        renderScreenerView();
      },
      onFilter: (patch) => {
        Object.assign(state.screener, patch);
        loadScreener();
      },
    },
  });
}

async function loadScreener() {
  try {
    state.screenerData = await api.fetchScreener(state.screener.basis, state.screener.sector);
    dom.screenerCount.textContent = String(state.screenerData.total ?? '');
  } catch (err) {
    state.screenerData = { error: err.message };
  }
  renderScreenerView();
}

function showScreenerView() {
  store.view = 'screener';
  saveView();
  clearSymbolFromUrl();
  setVisibleView('screener');
  renderWatchlist();
  renderWalletList();
  renderScreenerView();
  if (!state.screenerData) loadScreener();
}

/* -------------------------------------------------------------------- detail */

/** The URL names the open company; leaving one should stop it naming it. */
function clearSymbolFromUrl() {
  const url = new URL(location.href);
  if (!url.searchParams.has('symbol')) return;
  url.searchParams.delete('symbol');
  history.replaceState(null, '', url);
}

function selectSymbol(symbol) {
  const wasWallet = store.view === 'wallet';
  showStockView();
  if (state.active === symbol && state.stock && !wasWallet) return;
  state.active = symbol;
  writeStore(STORE.symbol, symbol);

  // Keep the address bar in step so the view stays copy-pasteable.
  const url = new URL(location.href);
  url.searchParams.set('symbol', symbol);
  history.replaceState(null, '', url);

  renderWatchlist();
  loadStock();
}

function renderEmptyDetail() {
  render(dom.hero, el('p', { class: 'empty', text: 'Add a ticker from the search box to get started.' }));
  for (const node of [dom.priceCard, dom.scoreCard, dom.stats, dom.financialsCard, dom.incomeStatement, dom.dividendCard, dom.targetCard, dom.aboutCard]) {
    clear(node);
  }
}

async function loadStock() {
  if (!state.active) return renderEmptyDetail();

  const token = ++state.requestToken;
  state.loading = true;
  dom.detail.classList.add('is-loading');

  // First load has nothing to hold onto; later loads keep the previous render
  // at reduced opacity instead of flashing a skeleton.
  if (!state.stock) {
    render(dom.hero, el('div', { class: 'skeleton', style: { height: '110px' } }));
    render(dom.priceCard, el('div', { class: 'skeleton' }));
  }

  try {
    const stock = await api.fetchStock(state.active, state.range, state.period);
    if (token !== state.requestToken) return; // a newer request won
    state.stock = stock;
    renderDetail(stock);
  } catch (err) {
    if (token !== state.requestToken) return;
    state.stock = null;
    render(
      dom.hero,
      el('p', { class: 'error-note', text: `Could not load ${state.active}: ${err.message}` }),
    );
    for (const node of [dom.priceCard, dom.scoreCard, dom.stats, dom.financialsCard, dom.incomeStatement, dom.dividendCard, dom.targetCard, dom.aboutCard]) {
      clear(node);
    }
  } finally {
    if (token === state.requestToken) {
      state.loading = false;
      dom.detail.classList.remove('is-loading');
    }
  }
}

function renderDetail(stock) {
  renderHero(stock);
  renderPriceChart(stock);
  renderScore(stock);
  renderStats(stock);
  renderFinancials(stock);
  renderDividends(stock);
  renderIncomeStatement(stock);
  renderTargets(stock);
  renderAbout(stock);
}

/* ---------------------------------------------------------------------- hero */

function renderHero(stock) {
  const { quote } = stock;
  const code = quote.currency ?? 'USD';

  const tags = [
    quote.exchange,
    quote.sector,
    quote.quoteType && quote.quoteType !== 'EQUITY' ? quote.quoteType : null,
  ].filter(Boolean);

  const marketNote = [
    quote.marketTime ? `As of ${dateTime(quote.marketTime)}` : null,
    quote.marketState && quote.marketState !== 'REGULAR' ? `Market ${quote.marketState.toLowerCase()}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Searching no longer saves what you look at, so keeping a company has to be
  // an explicit act, and the control has to say which list it would go into.
  const listName = activeList()?.name ?? 'watchlist';
  const saved = symbols().includes(quote.symbol);
  const watchToggle = el('button', {
    class: saved ? 'watch-toggle saved' : 'watch-toggle',
    type: 'button',
    text: saved ? `✓ In ${listName}` : `＋ Add to ${listName}`,
    title: saved ? `Remove ${quote.symbol} from ${listName}` : `Add ${quote.symbol} to ${listName}`,
    onclick: () => (saved ? removeTickerFromList(quote.symbol) : addTickerToList(quote.symbol)),
  });

  const left = el(
    'div',
    {},
    el(
      'div',
      { class: 'hero-id' },
      el('span', { class: 'hero-symbol', text: quote.symbol }),
      el('span', { class: 'hero-name', text: quote.name }),
      ...tags.map((t) => el('span', { class: 'tag', text: t })),
      watchToggle,
    ),
    el('div', { class: 'hero-price', text: quote.price == null ? DASH : currency(quote.price, code) }),
    el(
      'div',
      { class: 'hero-delta' },
      deltaNode(quote.change, quote.changePercent, code, { priceRef: quote.price }),
      el('span', { class: 'delta-flat', style: { fontWeight: '400', fontSize: '13px' }, text: 'today' }),
    ),
    marketNote ? el('div', { class: 'hero-meta', text: marketNote }) : null,
  );

  const sessionFacts = [
    ['Open', quote.open == null ? null : currency(quote.open, code)],
    ['Previous close', quote.previousClose == null ? null : currency(quote.previousClose, code)],
    [
      "Day's range",
      quote.dayLow == null || quote.dayHigh == null
        ? null
        : `${currency(quote.dayLow, code)} – ${currency(quote.dayHigh, code)}`,
    ],
    ['Volume', quote.volume == null ? null : integer(quote.volume)],
  ].filter(([, value]) => value);

  const right = el(
    'div',
    { class: 'hero-side' },
    rangeMeter(quote, code),
    sessionFacts.length
      ? el(
          'div',
          { class: 'hero-facts' },
          ...sessionFacts.map(([label, value]) =>
            el('div', {}, el('div', { class: 'fact-label', text: label }), el('div', { class: 'fact-value', text: value })),
          ),
        )
      : null,
  );

  render(dom.hero, left, right);

  // Stored data is labelled, never passed off as live. A reader deciding on
  // these numbers should know whether they are today's.
  if (stock.servedFromWarehouse?.length) {
    const asOf = stock.warehouseAsOf ? ` as of ${isoDate(stock.warehouseAsOf)}` : '';
    dom.hero.append(
      el('div', {
        class: 'banner',
        style: { gridColumn: '1 / -1' },
        text:
          `Showing stored ${stock.servedFromWarehouse.join(' and ')}${asOf}, the live feed is ` +
          `rate-limited right now. Prices are current.`,
      }),
    );
  }

  if (stock.degraded?.length) {
    dom.hero.append(
      el('div', {
        class: 'banner',
        style: { gridColumn: '1 / -1' },
        text: `Some panels are unavailable right now (${stock.degraded.join(', ')}). Prices are unaffected.`,
      }),
    );
  }
}

/** 52-week position: a meter, because the story is one number in a range. */
function rangeMeter(quote, code) {
  const { fiftyTwoWeekLow: low, fiftyTwoWeekHigh: high, price } = quote;
  if (low == null || high == null || price == null || high <= low) return el('div');

  const pct = Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
  return el(
    'div',
    { class: 'range-meter' },
    el(
      'div',
      { class: 'range-meter-head' },
      el('span', { text: '52-week range' }),
      el('span', { style: { color: 'var(--text-primary)', fontWeight: '600' }, text: `${percent(pct, { digits: 0 })} of range` }),
    ),
    el(
      'div',
      { class: 'meter-track' },
      el('div', { class: 'meter-fill', style: { right: `${100 - pct}%` } }),
      el('div', { class: 'meter-marker', style: { left: `${pct}%` } }),
    ),
    el(
      'div',
      { class: 'meter-ends' },
      el('span', { text: `Low ${currency(low, code)}` }),
      el('span', { text: `High ${currency(high, code)}` }),
    ),
  );
}

/* --------------------------------------------------------------- price chart */

function renderPriceChart(stock) {
  const { chart, quote } = stock;
  const code = chart.currency ?? 'USD';
  const points = chart.points;
  const rangeInfo = RANGES.find((r) => r.key === state.range);

  const first = points[0]?.c;
  const last = points.at(-1)?.c;
  const periodChange = first != null && last != null ? last - first : null;
  const periodPct = first ? (periodChange / first) * 100 : null;
  const dir = direction(periodChange);

  // The line's color states the period's direction, the same fact the signed
  // number beside it states, so it is never carried by hue alone.
  const color = dir === 'down' ? cssVar('--down') : dir === 'up' ? cssVar('--up') : cssVar('--series-1');
  const symbol = currencySymbol(code);

  mountChart(dom.priceCard, {
    title: `${quote.symbol} price`,
    subtitle:
      `${rangeInfo?.blurb ?? ''}` +
      (periodPct != null ? ` · ${periodChange > 0 ? '+' : ''}${percent(periodPct)} over the period` : ''),
    height: 320,
    draw: (width, height) =>
      areaChart(width, height, {
        points,
        color,
        ariaLabel: `${quote.name} closing price, ${rangeInfo?.label ?? state.range}`,
        formatValue: (v) => `${symbol}${compact(v)}`,
        endLabel: last == null ? null : currency(last, code),
        referenceValue: state.range === '1d' ? chart.previousClose : null,
        formatTooltip: (point) => [
          state.range === '1d' || state.range === '5d' ? dateTime(point.t) : shortDate(point.t),
          [
            { label: 'Close', value: currency(point.c, code), color },
            first != null
              ? {
                  label: 'From period start',
                  value: `${point.c - first > 0 ? '+' : ''}${percent(((point.c - first) / first) * 100)}`,
                }
              : null,
          ].filter(Boolean),
        ],
      }),
    table: {
      columns: ['Date', 'Close', 'Volume'],
      rows: [...points]
        .reverse()
        .map((p) => [
          state.range === '1d' || state.range === '5d' ? dateTime(p.t) : shortDate(p.t),
          currency(p.c, code),
          integer(p.v),
        ]),
    },
  });
}

/* ---------------------------------------------------------------- stat tiles */

function renderStats(stock) {
  const code = stock.quote.currency ?? 'USD';

  if (!stock.groups.length) {
    render(dom.stats, el('div', { class: 'card' }, el('p', { class: 'empty', text: 'No fundamental data available for this security.' })));
    return;
  }

  // One card of dense label/value rows rather than a tile per metric: at ~38
  // figures the tiles were mostly border and padding, and the eye had to hop
  // between boxes to compare two numbers in the same group.
  render(
    dom.stats,
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', { class: 'card-title', text: 'Key statistics' })),
      el(
        'div',
        { class: 'stats-columns' },
        ...stock.groups.map((group) =>
          el(
            'section',
            { class: 'stat-group' },
            el('h4', { class: 'stats-title', text: group.title }),
            el(
              'dl',
              { class: 'stat-rows' },
              ...group.metrics.flatMap((metric) => [
                el(
                  'dt',
                  {},
                  metric.hint
                    ? el('abbr', { class: 'stat-hint', title: metric.hint, text: metric.label })
                    : el('span', { text: metric.label }),
                ),
                el('dd', { text: metricValue(metric, code) }),
              ]),
            ),
          ),
        ),
      ),
    ),
  );
}

/* --------------------------------------------------------- quality score ---- */

/** Score bands are a state, so they use status tokens, always beside the
 *  number and the word, never carrying the meaning on their own. */
function scoreTone(score) {
  if (!Number.isFinite(score)) return cssVar('--text-muted');
  if (score >= 70) return cssVar('--up');
  if (score >= 45) return cssVar('--warning');
  return cssVar('--down');
}

const scoreBand = (score) =>
  !Number.isFinite(score) ? DASH : score >= 75 ? 'Strong' : score >= 60 ? 'Solid' : score >= 45 ? 'Mixed' : score >= 30 ? 'Weak' : 'Poor';

function scoreMeter(score) {
  const tone = scoreTone(score);
  return el(
    'div',
    {
      class: 'score-meter',
      style: { background: `color-mix(in srgb, ${tone} 18%, transparent)` },
      role: 'img',
      'aria-label': `${score ?? 'not'} out of 100`,
    },
    el('div', {
      class: 'score-meter-fill',
      style: { width: `${Math.max(2, Number.isFinite(score) ? score : 0)}%`, background: tone },
    }),
  );
}

/* ----------------------------------------------------------- score history */

/** Signed return with an arrow, so direction never rests on colour alone. */
function returnCell(value) {
  if (value == null) return el('span', { class: 'muted', text: DASH });
  const dir = direction(value);
  return el(
    'span',
    { class: `delta-${dir}` },
    el('span', { class: 'delta-arrow', 'aria-hidden': 'true', text: ARROW[dir] }),
    ' ',
    `${value > 0 ? '+' : ''}${percent(value, { digits: 1 })}`,
  );
}

/**
 * How each past period would have graded, and what the shares did over it.
 *
 * The scores are recomputed from the statements rather than recorded at the
 * time, which is stated on the block rather than left for the reader to assume
 * otherwise. Periods graded on thin statement history are marked, because the
 * earliest point in any series has the least behind it and would otherwise read
 * as a real decline in quality rather than a change in how much was known.
 */
function scoreHistoryBlock(stock) {
  const history = stock.scoreHistory;
  if (!history) return null;

  const quarterly = state.historyPeriod === 'quarterly';
  const active = quarterly ? history.quarterly : history.annual;
  const periods = active?.periods ?? [];

  const toggle = el(
    'div',
    { class: 'segmented' },
    ...[
      ['annual', 'Years'],
      ['quarterly', 'Quarters'],
    ].map(([key, label]) =>
      el('button', {
        type: 'button',
        text: label,
        'aria-pressed': String(state.historyPeriod === key),
        onclick: () => {
          state.historyPeriod = key;
          writeStore(STORE.historyPeriod, key);
          renderScore(state.stock);
        },
      }),
    ),
  );

  const head = el(
    'div',
    { class: 'card-head', style: { marginTop: '4px' } },
    el('h4', { class: 'stats-title', style: { margin: 0 }, text: 'Score history' }),
    toggle,
  );

  if (!periods.length) {
    return el(
      'div',
      { class: 'score-history' },
      head,
      el('p', {
        class: 'empty',
        text: quarterly
          ? 'Not enough quarterly statements to grade a trailing year. Yahoo keeps about five quarters, and a score needs four of them.'
          : 'No past periods can be graded from the statements on file.',
      }),
    );
  }

  // Two separate kinds of thinness, and a row can carry either. Annual rows
  // are thin when few reporting periods sit behind the grade; quarterly rows
  // are thin when the trailing year was annualised from fewer than four
  // quarters, which imports whatever seasonality the missing ones would have
  // offset.
  const isThin = (row) => row.statementPeriods < 3 || (row.quartersUsed != null && row.quartersUsed < 4);
  const thinReason = (row) =>
    row.quartersUsed != null && row.quartersUsed < 4
      ? `Annualised from ${row.quartersUsed} quarter${row.quartersUsed === 1 ? '' : 's'} rather than a full four, so any seasonality in the missing quarters is scaled up with it.`
      : `Graded on ${row.statementPeriods} reporting period${row.statementPeriods === 1 ? '' : 's'} of statements, so its growth pillar rests on less than the later ones.`;
  const thin = periods.some(isThin);

  const body = el(
    'tbody',
    {},
    ...periods.map((row) =>
      el(
        'tr',
        {},
        el(
          'th',
          { scope: 'row' },
          row.label,
          isThin(row) ? el('abbr', { class: 'thin-marker', title: thinReason(row), text: '*' }) : null,
        ),
        el('td', {}, scoreMeter(row.score)),
        el('td', { class: 'score-history-value', style: { color: scoreTone(row.score) }, text: String(row.score) }),
        el('td', { text: row.grade ?? DASH }),
        el('td', {}, returnCell(row.totalReturn)),
      ),
    ),
  );

  return el(
    'div',
    { class: 'score-history' },
    head,
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        { class: 'data score-history-table' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            ...['Period', '', 'Score', 'Grade', 'Total return'].map((label) =>
              el('th', { scope: 'col', text: label }),
            ),
          ),
        ),
        body,
      ),
    ),
    el('p', {
      class: 'card-sub',
      style: { marginTop: '10px', marginBottom: 0 },
      text:
        'Recomputed from the statements on file, not recorded at the time, so a later restatement is included and this is not what the screener would have printed then. ' +
        'Return is over the reporting period itself, with dividends reinvested. ' +
        (quarterly ? 'Quarters are graded on the trailing twelve months, since the scorer reasons in years throughout.' : ''),
    }),
    thin
      ? el('p', {
          class: 'card-sub',
          style: { marginTop: '6px', marginBottom: 0 },
          text: quarterly
            ? '* Annualised from fewer than four quarters. The average quarter is scaled up to a year, so a seasonal business reads high or low depending on which quarters are missing. Hover a row for its count.'
            : '* Graded on fewer than three reporting periods. Its growth pillar has less behind it than the later rows, so read it as indicative rather than comparable.',
        })
      : null,
    active.unscored?.length
      ? el('p', {
          class: 'card-sub',
          style: { marginTop: '6px', marginBottom: 0 },
          text: `Not graded: ${active.unscored.map((u) => `${u.period} (${u.reason})`).join(', ')}.`,
        })
      : null,
  );
}

function renderScore(stock) {
  const score = stock.score;
  const head = el(
    'div',
    { class: 'card-head' },
    el('h3', { class: 'card-title', text: 'Quality score' }),
    score
      ? el('span', {
          class: 'tag',
          text: score.basis === 'reit' ? 'REIT basis' : 'Standard basis',
        })
      : null,
  );

  if (!score || score.overall == null) {
    render(
      dom.scoreCard,
      head,
      el('p', {
        class: 'empty',
        text: 'Not enough reported financial data to score this security.',
      }),
    );
    return;
  }

  const basisNote =
    score.basis === 'reit'
      ? `Scored as a REIT: FFO replaces earnings, and the payout is measured against cash flow rather than EPS.`
      : `Scored as an operating company: earnings, free cash flow and P/E.`;

  const pillars = el(
    'div',
    { class: 'pillar-list' },
    ...score.pillars.map((p) =>
      el(
        'details',
        { class: 'pillar' },
        el(
          'summary',
          {},
          el('span', { class: 'pillar-name', text: p.title }),
          scoreMeter(p.score),
          el('span', { class: 'pillar-score', style: { color: scoreTone(p.score) }, text: p.score ?? DASH }),
          el('span', { class: 'pillar-band', text: scoreBand(p.score) }),
          el('span', { class: 'pillar-caret', 'aria-hidden': 'true', text: '▶' }),
        ),
        el(
          'div',
          { class: 'pillar-detail' },
          el('div', { class: 'pillar-basis', text: p.basis }),
          ...p.metrics.map((m) =>
            el(
              'div',
              { class: 'pillar-metric' },
              m.hint
                ? el('abbr', { class: 'pillar-metric-label stat-hint', title: m.hint, text: m.label })
                : el('span', { class: 'pillar-metric-label', text: m.label }),
              el('span', { class: 'pillar-metric-value', text: m.display ?? DASH }),
              el('span', { class: 'pillar-metric-score', text: m.score == null ? DASH : `${m.score}` }),
            ),
          ),
        ),
      ),
    ),
  );

  const figures = score.keyFigures.filter((f) => f.value);

  render(
    dom.scoreCard,
    head,
    el('p', { class: 'card-sub', style: { marginBottom: 0 }, text: basisNote }),
    el(
      'div',
      { class: 'score-layout' },
      el(
        'div',
        {},
        el(
          'div',
          { class: 'score-badge' },
          el('span', { class: 'score-overall', style: { color: scoreTone(score.overall) }, text: score.overall }),
          el('span', { class: 'score-grade', style: { color: scoreTone(score.overall) }, text: score.grade }),
          el('span', { class: 'score-band-label', text: score.band }),
        ),
        score.coverage < 100
          ? el('div', { class: 'score-coverage', text: `${score.coverage}% of pillars had data` })
          : null,
      ),
      pillars,
    ),
    scoreHistoryBlock(stock),
    figures.length
      ? el(
          'div',
          { class: 'score-figures' },
          ...figures.map((f) =>
            el(
              'div',
              {},
              el('div', { class: 'fact-label' }, f.hint ? el('abbr', { class: 'stat-hint', title: f.hint, text: f.label }) : f.label),
              el('div', { class: 'fact-value', text: f.value }),
            ),
          ),
        )
      : null,
    el(
      'details',
      { class: 'score-method' },
      el('summary', { text: 'How this is scored' }),
      el('p', {
        text:
          'Five pillars, each 0-100, combined into a weighted score: dividend safety 25%, balance sheet 25%, ' +
          'growth 20%, profitability 15%, valuation 15%. A pillar with no data is dropped and its weight ' +
          'is shared by the rest.',
      }),
      el(
        'ul',
        {},
        el('li', {
          text:
            score.basis === 'reit'
              ? 'REITs are scored on FFO (net income + depreciation), because depreciation on property that is holding its value pushes reported earnings (and therefore EPS, P/E and any earnings-based payout ratio) far below the cash the business actually produces.'
              : 'Operating companies are scored on reported earnings, free cash flow and P/E. A REIT would be scored on FFO instead.',
        }),
        el('li', {
          text:
            score.basis === 'reit'
              ? 'FFO here is estimated as net income plus depreciation and amortisation. True NAREIT FFO also excludes gains on property sales and adds back impairments; Yahoo does not report those lines, so a year with large property sales will read high.'
              : 'The payout ratio is averaged over three reported years, so a single distorted year does not swing the grade.',
        }),
        el('li', {
          text:
            'Thresholds are heuristics chosen for screening, not a validated model, and they differ by basis: 5-6× net debt to EBITDA is normal for a REIT and stretched for an operating company. Every input is shown above so you can disagree with the grade.',
        }),
        el('li', { text: 'For research and education. Not investment advice.' }),
      ),
    ),
  );
}

/* ----------------------------------------------------------- financials chart */

function periodLabel(isoDay, period) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDay;
  if (period === 'quarterly') {
    return `${d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })} '${String(d.getUTCFullYear()).slice(2)}`;
  }
  return String(d.getUTCFullYear());
}

function renderFinancials(stock) {
  const code = stock.quote.currency ?? 'USD';
  const limit = state.period === 'quarterly' ? 12 : 10;
  const rows = stock.financials.slice(-limit);
  const colors = seriesColors();
  const symbol = currencySymbol(code);

  const categories = rows.map((r) => ({
    label: periodLabel(r.date, state.period),
    tooltipLabel: `Period ending ${isoDate(r.date)}`,
  }));

  // Both series are money in the same currency, so they share one axis.
  const series = [
    { key: 'totalRevenue', name: 'Revenue', color: colors.s1, values: rows.map((r) => r.totalRevenue ?? null) },
    { key: 'netIncome', name: 'Net income', color: colors.s2, values: rows.map((r) => r.netIncome ?? null) },
  ];

  mountChart(dom.financialsCard, {
    title: 'Revenue & net income',
    subtitle: rows.length
      ? `${state.period === 'quarterly' ? 'Quarterly' : 'Annual'} reported results, ${code}`
      : 'No reported financials for this security',
    legend: series.map((s) => ({ name: s.name, color: s.color, shape: 'rect' })),
    height: 280,
    draw: (width, height) =>
      columnChart(width, height, {
        categories,
        series,
        ariaLabel: `${stock.quote.name} revenue and net income by ${state.period === 'quarterly' ? 'quarter' : 'year'}`,
        formatValue: (v) => (Number.isFinite(v) ? compactCurrency(v, code) : DASH),
        formatTick: (v) => `${v < 0 ? '-' : ''}${symbol}${compact(Math.abs(v))}`,
      }),
    table: {
      columns: ['Period', 'Revenue', 'Net income', 'Free cash flow', 'Diluted EPS'],
      rows: [...rows].reverse().map((r) => [
        periodLabel(r.date, state.period),
        compactCurrency(r.totalRevenue, code),
        compactCurrency(r.netIncome, code),
        compactCurrency(r.freeCashFlow, code),
        r.dilutedEPS == null ? DASH : currency(r.dilutedEPS, code),
      ]),
    },
  });
}

/* --------------------------------------------------------- income statement */

/**
 * The reported income statement, one column per period.
 *
 * `emphasis` marks the subtotal lines a reader scans for, revenue down to
 * EBITDA, so the eye can find them without every row shouting.
 * `derive` covers the two lines Yahoo does not report directly.
 */
const STATEMENT_ROWS = [
  { label: 'Revenue', key: 'totalRevenue', kind: 'currency', emphasis: true },
  { label: 'Cost of revenue', key: 'costOfRevenue', kind: 'currency' },
  { label: 'Gross profit', key: 'grossProfit', kind: 'currency', emphasis: true },
  { label: 'Research & development', key: 'researchAndDevelopment', kind: 'currency' },
  { label: 'Selling, general & administrative', key: 'sellingGeneralAndAdministration', kind: 'currency' },
  { label: 'Other operating expenses', key: 'otherOperatingExpenses', kind: 'currency' },
  { label: 'Operating expenses', key: 'operatingExpense', kind: 'currency' },
  { label: 'Total expenses', key: 'totalExpenses', kind: 'currency' },
  { label: 'Operating income', key: 'operatingIncome', kind: 'currency', emphasis: true },
  { label: 'Other non-operating income', key: 'otherNonOperatingIncomeExpenses', kind: 'currency' },
  { label: 'Interest income', key: 'interestIncome', kind: 'currency' },
  { label: 'Interest expense', key: 'interestExpense', kind: 'currency' },
  { label: 'Net interest income / (expense)', key: 'netInterestIncome', kind: 'currency' },
  { label: 'Pre-tax income', key: 'pretaxIncome', kind: 'currency', emphasis: true },
  { label: 'Income tax expense', key: 'taxProvision', kind: 'currency' },
  { label: 'Effective tax rate', key: 'taxRateForCalcs', kind: 'fraction' },
  { label: 'Net income', key: 'netIncome', kind: 'currency', emphasis: true },
  {
    label: 'Net profit margin',
    kind: 'percent',
    derive: (row) => (row.netIncome != null && row.totalRevenue ? (row.netIncome / row.totalRevenue) * 100 : null),
  },
  { label: 'Diluted EPS', key: 'dilutedEPS', kind: 'eps' },
  { label: 'Basic EPS', key: 'basicEPS', kind: 'eps' },
  { label: 'Diluted shares outstanding', key: 'dilutedAverageShares', kind: 'shares' },
  { label: 'Depreciation & amortisation', key: 'reconciledDepreciation', kind: 'currency' },
  { label: 'EBITDA', key: 'ebitda', kind: 'currency', emphasis: true },
  { label: 'Free cash flow', key: 'freeCashFlow', kind: 'currency' },
];

const statementValue = (row, spec) => (spec.derive ? spec.derive(row) : row[spec.key]);

function renderIncomeStatement(stock) {
  const code = stock.quote.currency ?? 'USD';
  const quarterly = state.period === 'quarterly';
  const rows = stock.financials.slice(quarterly ? -8 : -6);

  const head = el(
    'div',
    { class: 'card-head' },
    el('h3', { class: 'card-title', text: 'Income statement' }),
    el('span', { class: 'card-sub', style: { marginBottom: 0 }, text: `All values in ${code}` }),
  );

  if (!rows.length) {
    render(dom.incomeStatement, head, el('p', { class: 'empty', text: 'No reported financials for this security.' }));
    return;
  }

  const format = (value, kind) => {
    if (value == null) return DASH;
    switch (kind) {
      case 'currency':
        return compactCurrency(value, code);
      case 'fraction':
        return percent(value * 100);
      case 'percent':
        return percent(value);
      case 'eps':
        return currency(value, code, { digits: 2 });
      case 'shares':
        return integer(value);
      default:
        return String(value);
    }
  };

  // A line nobody reports for this business (a railway has no R&D) is dropped
  // rather than printed as a row of blanks.
  const present = STATEMENT_ROWS.filter((spec) => rows.some((row) => statementValue(row, spec) != null));

  render(
    dom.incomeStatement,
    head,
    el(
      'div',
      { class: 'table-scroll statement-scroll' },
      el(
        'table',
        { class: 'data statement' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { scope: 'col', text: quarterly ? 'Quarter ending' : 'Fiscal year' }),
            ...rows.map((row) => el('th', { scope: 'col', text: periodLabel(row.date, state.period) })),
          ),
        ),
        el(
          'tbody',
          {},
          ...present.map((spec) =>
            el(
              'tr',
              spec.emphasis ? { class: 'statement-key' } : {},
              el('th', { scope: 'row', text: spec.label }),
              ...rows.map((row) => el('td', { text: format(statementValue(row, spec), spec.kind) })),
            ),
          ),
        ),
      ),
    ),
    el('p', {
      class: 'card-sub',
      style: { marginTop: '12px', marginBottom: 0 },
      text: 'As reported to Yahoo Finance. Expense lines are shown with the sign Yahoo reports them under.',
    }),
  );
}

/* ------------------------------------------------------------ dividend chart */

function renderDividends(stock) {
  const code = stock.quote.currency ?? 'USD';
  const rows = stock.dividends ?? [];
  const symbol = currencySymbol(code);
  const partial = rows.find((r) => r.partial);

  if (!rows.length) {
    render(
      dom.dividendCard,
      el('div', { class: 'card-head' }, el('h3', { class: 'card-title', text: 'Dividend history' })),
      el('p', { class: 'empty', text: 'This security has not paid a dividend.' }),
    );
    disposers.get(dom.dividendCard)?.();
    disposers.delete(dom.dividendCard);
    return;
  }

  const growth =
    rows.length >= 2 && rows.at(-2).amount > 0 && !rows.at(-1).partial
      ? ((rows.at(-1).amount - rows.at(-2).amount) / rows.at(-2).amount) * 100
      : null;

  mountChart(dom.dividendCard, {
    title: 'Dividends per share',
    subtitle:
      `Paid per calendar year, ${code}` + (growth != null ? ` · ${growth > 0 ? '+' : ''}${percent(growth)} year over year` : ''),
    height: 280,
    // Single series, the title says what is plotted, so no legend box.
    draw: (width, height) =>
      columnChart(width, height, {
        categories: rows.map((r) => ({
          label: String(r.year),
          tooltipLabel: r.partial ? `${r.year} (year to date)` : String(r.year),
        })),
        series: [
          {
            key: 'amount',
            name: 'Dividends per share',
            color: cssVar('--series-1'),
            values: rows.map((r) => r.amount),
          },
        ],
        ariaLabel: `${stock.quote.name} dividends per share by calendar year`,
        // Per-share amounts are quoted in cents, not the 4 decimals a sub-dollar
        // price would get.
        formatValue: (v) => currency(v, code, { digits: 2 }),
        formatTick: (v) => `${symbol}${ratio(v, { digits: v >= 10 ? 0 : 2 })}`,
        // Direct-labelling the newest bar is only honest when the year is done.
        labelLast: !rows.at(-1).partial,
      }),
    note: partial ? `${partial.year} is still accruing. Its bar covers payments made so far this year.` : null,
    table: {
      columns: ['Year', 'Dividends per share'],
      rows: [...rows]
        .reverse()
        .map((r) => [r.partial ? `${r.year} (to date)` : String(r.year), currency(r.amount, code, { digits: 2 })]),
    },
  });
}

/* ------------------------------------------------------------- analyst card */

function renderTargets(stock) {
  const { targets, consensus, quote } = stock;
  const code = quote.currency ?? 'USD';
  const head = el('div', { class: 'card-head' }, el('h3', { class: 'card-title', text: 'Analyst view' }));

  if (targets.mean == null && !consensus) {
    render(dom.targetCard, head, el('p', { class: 'empty', text: 'No analyst coverage available.' }));
    return;
  }

  const upside = targets.mean != null && quote.price ? ((targets.mean - quote.price) / quote.price) * 100 : null;

  const cells = el(
    'div',
    { class: 'target-grid' },
    ...[
      ['Low', targets.low],
      ['Average', targets.mean],
      ['High', targets.high],
    ].map(([label, value]) =>
      el(
        'div',
        { class: 'target-cell' },
        el('div', { class: 'target-cell-label', text: label }),
        el('div', { class: 'target-cell-value', text: value == null ? DASH : currency(value, code) }),
      ),
    ),
  );

  /* Where today's price sits inside the analyst target band. */
  let band = null;
  if (targets.low != null && targets.high != null && targets.high > targets.low && quote.price != null) {
    const span = targets.high - targets.low;
    const clamp = (v) => Math.min(100, Math.max(0, ((v - targets.low) / span) * 100));
    band = el(
      'div',
      { class: 'range-meter', style: { minWidth: '0' } },
      el(
        'div',
        { class: 'range-meter-head' },
        el('span', { text: 'Price vs target band' }),
        el(
          'span',
          { style: { fontWeight: '600' } },
          upside == null
            ? DASH
            : el('span', { class: `delta-${direction(upside)}`, text: `${upside > 0 ? '+' : ''}${percent(upside)} to average` }),
        ),
      ),
      el(
        'div',
        { class: 'meter-track' },
        el('div', { class: 'meter-fill', style: { right: `${100 - clamp(targets.mean ?? quote.price)}%` } }),
        el('div', {
          class: 'meter-marker',
          style: { left: `${clamp(quote.price)}%` },
          title: `Current price ${currency(quote.price, code)}`,
        }),
      ),
      el(
        'div',
        { class: 'meter-ends' },
        el('span', { text: `Low ${currency(targets.low, code)}` }),
        el('span', { text: `Current ${currency(quote.price, code)}` }),
        el('span', { text: `High ${currency(targets.high, code)}` }),
      ),
    );
  }

  /* Ratings folded to three ordered classes on the diverging blue/gray/red
     scale, since five near-identical hues would blur, and each class is labelled
     with its count, so color is never the only channel. */
  let ratings = null;
  if (consensus) {
    const buckets = [
      { name: 'Buy', count: consensus.strongBuy + consensus.buy, color: cssVar('--series-1') },
      { name: 'Hold', count: consensus.hold, color: cssVar('--text-muted') },
      { name: 'Sell', count: consensus.sell + consensus.strongSell, color: cssVar('--down') },
    ];
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    if (total > 0) {
      ratings = el(
        'div',
        { style: { marginTop: '20px' } },
        el('div', { class: 'card-sub', style: { marginBottom: '2px' }, text: `${total} analyst ratings this month` }),
        el(
          'div',
          { class: 'consensus-bar' },
          ...buckets
            .filter((b) => b.count > 0)
            .map((b) =>
              el('div', {
                class: 'consensus-seg',
                style: { flex: String(b.count), background: b.color },
                title: `${b.name}: ${b.count}`,
              }),
            ),
        ),
        el(
          'div',
          { class: 'consensus-legend' },
          ...buckets.map((b) =>
            el(
              'span',
              { class: 'legend-item' },
              el('span', { class: 'legend-swatch', style: { background: b.color } }),
              el('span', { text: `${b.name} ${b.count}` }),
            ),
          ),
        ),
      );
    }
  }

  render(
    dom.targetCard,
    head,
    el('p', {
      class: 'card-sub',
      text: targets.analysts ? `Price targets from ${integer(targets.analysts)} analysts` : 'Analyst price targets',
    }),
    cells,
    band,
    ratings,
  );
}

/* ---------------------------------------------------------------- about card */

function renderAbout(stock) {
  const { quote } = stock;
  const facts = [
    ['Sector', quote.sector],
    ['Industry', quote.industry],
    ['Employees', quote.employees == null ? null : integer(quote.employees)],
    ['Country', quote.country],
    ['Exchange', quote.exchange],
  ].filter(([, value]) => value);

  render(
    dom.aboutCard,
    el('div', { class: 'card-head' }, el('h3', { class: 'card-title', text: `About ${quote.symbol}` })),
    quote.description
      ? el('p', { class: 'about-text', text: quote.description })
      : el('p', { class: 'card-sub', text: 'No company description available.' }),
    facts.length || quote.website
      ? el(
          'div',
          { class: 'about-facts' },
          ...facts.map(([label, value]) =>
            el('div', {}, el('div', { class: 'fact-label', text: label }), el('div', { class: 'fact-value', text: value })),
          ),
          quote.website
            ? el(
                'div',
                {},
                el('div', { class: 'fact-label', text: 'Website' }),
                el(
                  'div',
                  { class: 'fact-value' },
                  el('a', { href: quote.website, target: '_blank', rel: 'noopener noreferrer', text: 'Company site' }),
                ),
              )
            : null,
        )
      : null,
  );
}

/* ------------------------------------------------------------------- filters */

function renderFilters() {
  // The range is shared by both views, so changing it reloads whichever is on
  // screen and leaves the other to reload when it next opens.
  const rangeButtons = (node) =>
    render(
      node,
      ...RANGES.map((range) =>
        el('button', {
          type: 'button',
          text: range.label,
          'aria-pressed': String(range.key === state.range),
          onclick: () => {
            if (state.range === range.key) return;
            state.range = range.key;
            writeStore(STORE.range, range.key);
            renderFilters();
            if (store.view === 'wallet') loadWalletData();
            else loadStock();
          },
        }),
      ),
    );

  rangeButtons(dom.rangePicker);
  rangeButtons(dom.walletRangePicker);

  render(
    dom.periodPicker,
    ...PERIODS.map((period) =>
      el('button', {
        type: 'button',
        text: period.label,
        'aria-pressed': String(period.key === state.period),
        onclick: () => {
          if (state.period === period.key) return;
          state.period = period.key;
          writeStore(STORE.period, period.key);
          renderFilters();
          loadStock();
        },
      }),
    ),
  );
}

/* ---------------------------------------------------------------------- tabs */

function showTab(id) {
  const target = TABS.find((t) => t.id === id) ?? TABS[0];
  state.tab = target.id;
  writeStore(STORE.tab, target.id);

  for (const tab of TABS) {
    const selected = tab === target;
    const button = document.getElementById(`tab-${tab.id}`);
    button.setAttribute('aria-selected', String(selected));
    // Roving tabindex: the tablist is one stop, arrows move within it.
    button.tabIndex = selected ? 0 : -1;
    document.getElementById(`panel-${tab.id}`).hidden = !selected;
  }

  target.repaint?.();
}

function showWalletTab(id) {
  const target = WALLET_TABS.find((t) => t.id === id) ?? WALLET_TABS[0];
  state.walletTab = target.id;
  writeStore(STORE.walletTab, target.id);

  for (const tab of WALLET_TABS) {
    const selected = tab === target;
    const button = document.getElementById(`wtab-${tab.id}`);
    if (!button) continue;
    button.setAttribute('aria-selected', String(selected));
    // Roving tabindex: the tablist is one tab stop, arrows move within it.
    button.tabIndex = selected ? 0 : -1;
    const panel = dom.walletPanels?.[tab.id];
    if (panel) panel.hidden = !selected;
  }

  // Re-render on the way in so whichever chart was hidden gets measured against
  // a container that now has a width.
  renderWalletView();
}

function setupWalletTabs() {
  WALLET_TABS.forEach((tab, index) => {
    const button = document.getElementById(`wtab-${tab.id}`);
    if (!button) throw new Error(`#wtab-${tab.id} is missing from the page`);
    button.addEventListener('click', () => showWalletTab(tab.id));
    button.addEventListener('keydown', (event) => {
      let next = null;
      if (event.key === 'ArrowRight') next = (index + 1) % WALLET_TABS.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + WALLET_TABS.length) % WALLET_TABS.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = WALLET_TABS.length - 1;
      if (next == null) return;
      event.preventDefault();
      showWalletTab(WALLET_TABS[next].id);
      document.getElementById(`wtab-${WALLET_TABS[next].id}`)?.focus();
    });
  });

  showWalletTab(state.walletTab);
}

function setupTabs() {
  TABS.forEach((tab, index) => {
    const button = document.getElementById(`tab-${tab.id}`);
    button.addEventListener('click', () => showTab(tab.id));
    button.addEventListener('keydown', (event) => {
      let next = null;
      if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = TABS.length - 1;
      if (next == null) return;
      event.preventDefault();
      showTab(TABS[next].id);
      document.getElementById(`tab-${TABS[next].id}`).focus();
    });
  });

  showTab(state.tab);
}

/* -------------------------------------------------------------------- search */

let searchResults = [];
let activeResult = -1;

function closeSearch() {
  dom.searchResults.hidden = true;
  dom.search.setAttribute('aria-expanded', 'false');
  activeResult = -1;
}

function renderSearchResults() {
  if (!searchResults.length) {
    render(dom.searchResults, el('li', { class: 'search-empty', role: 'presentation', text: 'No matches' }));
  } else {
    render(
      dom.searchResults,
      ...searchResults.map((result, index) =>
        el(
          'li',
          {
            role: 'option',
            id: `search-option-${index}`,
            'aria-selected': String(index === activeResult),
            onmousedown: (event) => {
              event.preventDefault(); // keep focus so blur does not race the click
              viewSymbol(result.symbol);
              dom.search.value = '';
              closeSearch();
            },
          },
          el('span', { class: 'result-symbol', text: result.symbol }),
          el('span', { class: 'result-name', text: result.name }),
          el('span', { class: 'result-meta', text: [result.type, result.exchange].filter(Boolean).join(' · ') }),
        ),
      ),
    );
  }
  dom.searchResults.hidden = false;
  dom.search.setAttribute('aria-expanded', 'true');
  dom.search.setAttribute('aria-activedescendant', activeResult >= 0 ? `search-option-${activeResult}` : '');
}

const runSearch = debounce(async (query) => {
  try {
    searchResults = await api.searchSymbols(query);
    activeResult = -1;
    renderSearchResults();
  } catch {
    searchResults = [];
    renderSearchResults();
  }
}, 220);

function setupSearch() {
  dom.search.addEventListener('input', () => {
    const query = dom.search.value.trim();
    if (query.length < 1) return closeSearch();
    runSearch(query);
  });

  dom.search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') return closeSearch();

    if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = searchResults[activeResult] ?? searchResults[0];
      const symbol = chosen?.symbol ?? dom.search.value.trim().toUpperCase();
      if (symbol) {
        viewSymbol(symbol);
        dom.search.value = '';
        closeSearch();
      }
      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (dom.searchResults.hidden || !searchResults.length) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    activeResult = (activeResult + step + searchResults.length) % searchResults.length;
    renderSearchResults();
  });

  // Ctrl/Cmd-K and "/" both focus search, the two conventions people reach for.
  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if ((event.key === 'k' && (event.ctrlKey || event.metaKey)) || (event.key === '/' && !typing)) {
      event.preventDefault();
      dom.search.focus();
      dom.search.select();
    }
  });

  dom.search.addEventListener('blur', () => setTimeout(closeSearch, 120));
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.search')) closeSearch();
  });
}

/* --------------------------------------------------------------------- theme */

function currentTheme() {
  return (
    document.documentElement.dataset.theme ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
}

function setupTheme() {
  const sync = () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    dom.themeToggle.setAttribute('aria-label', `Switch to ${next} theme`);
  };
  sync();

  dom.themeToggle.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    writeStore(STORE.theme, next);
    sync();
    // Charts re-read their colors from CSS variables via a MutationObserver.
    renderWatchlist();
    if (state.stock) {
      renderTargets(state.stock);
      renderScore(state.stock);
    }
  });
}

/* ---------------------------------------------------------------------- init */

function startAutoRefresh() {
  setInterval(() => {
    if (document.hidden) return; // no point polling a tab nobody is looking at
    loadWatchlistQuotes();
    loadMarket();
  }, REFRESH_MS);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadWatchlistQuotes();
  });
  window.addEventListener('scroll', hideTooltip, { passive: true });
}

/**
 * Run one startup step in isolation.
 *
 * Startup used to be a bare sequence, so a single failure took out everything
 * after it, and it failed silently, because nothing was watching. An
 * unguarded `dom.navScreener.addEventListener(...)` sitting above `loadStock()`
 * was enough: when the markup and the script disagreed about whether that
 * element existed (a stale cached script against fresh HTML, or a half-applied
 * deploy), init threw there and the detail panels simply never rendered. No
 * error, no clue, just blank cards.
 *
 * Wiring the sidebar is not a precondition for showing a company, so a step
 * that fails now reports itself and the rest still runs.
 */
function step(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[init] ${name} failed:`, err);
    failedSteps.push(`${name}: ${err.message}`);
  }
}

const failedSteps = [];

/** A broken startup should say so rather than looking like empty data. */
function reportStartupFailures() {
  if (!failedSteps.length) return;
  const banner = el('div', {
    class: 'banner',
    style: { margin: '12px 24px 0', display: 'block' },
  });
  banner.append(
    el('strong', { text: 'Some of the interface failed to start. ' }),
    el('span', { text: 'A hard reload (Ctrl+Shift+R) usually fixes it: the page and its scripts may be out of step. ' }),
    el('span', { class: 'card-sub', text: failedSteps.join(' · ') }),
  );
  document.querySelector('.layout')?.before(banner);
}

function init() {
  step('filters', renderFilters);
  step('watchlist picker', renderListPicker);
  step('watchlist', renderWatchlist);
  step('wallet list', renderWalletList);
  step('watchlist controls', setupLists);
  step('wallet controls', setupWallets);
  step('tabs', setupTabs);
  step('wallet tabs', setupWalletTabs);
  step('map nav', () => {
    if (!dom.navMap) throw new Error('#nav-map is missing from the page');
    dom.navMap.addEventListener('click', showMapView);
  });
  step('compare nav', () => {
    if (!dom.navCompare) throw new Error('#nav-compare is missing from the page');
    dom.navCompare.addEventListener('click', showCompareView);
  });
  step('screener nav', () => {
    // Thrown rather than optional-chained: swallowing a missing element keeps
    // the app alive but hides the fact that the markup and the script disagree,
    // which is worth surfacing even though it is no longer fatal.
    if (!dom.navScreener) throw new Error('#nav-screener is missing from the page');
    dom.navScreener.addEventListener('click', showScreenerView);
  });
  step('search', setupSearch);
  step('theme', setupTheme);

  loadMarket();
  // Cheap: the health endpoint already reports how many securities are scored,
  // so the sidebar shows the count without pulling the whole screener payload.
  api
    .fetchHealth()
    .then((h) => {
      if (h?.warehouse?.scored) dom.screenerCount.textContent = String(h.warehouse.scored);
    })
    .catch(() => {});

  // The main view is loaded outside the guarded steps: if this cannot run there
  // is nothing to show, and the error belongs on screen rather than in a banner.
  // The screener is the landing view: it is the one screen that says what this
  // app is, and arriving on a single company assumes you already knew which one
  // you wanted. A ?symbol= link still opens that company directly, and because
  // selecting one writes the symbol into the URL, refreshing while reading a
  // company keeps you there rather than bouncing back to the list.
  if (linked && dom.detail) {
    showStockView();
    loadStock();
  } else if (store.view === 'map' && dom.mapView) {
    showMapView();
  } else if (store.view === 'wallet' && activeWallet()) {
    setVisibleView('wallet');
    renderWalletView();
    loadWalletData();
  } else if (dom.screenerView) {
    showScreenerView();
  } else {
    showStockView();
    loadStock();
  }

  loadWatchlistQuotes().then(loadSparklines);
  startAutoRefresh();
  reportStartupFailures();
}

init();
