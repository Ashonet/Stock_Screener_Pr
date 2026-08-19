/**
 * Persisted user state: named watchlists and wallets.
 *
 * Everything lives in localStorage. There is no account and no server-side
 * state, so the dashboard is yours alone and works offline apart from prices.
 */

const KEYS = {
  lists: 'sd:lists',
  activeList: 'sd:activeList',
  wallets: 'sd:wallets',
  activeWallet: 'sd:activeWallet',
  view: 'sd:view',
  // Pre-multi-list keys, migrated on first load and then left alone.
  legacyList: 'sd:watchlist',
  legacySymbol: 'sd:active',
  // Set when the demo wallet is deleted, so it is not put back on the next
  // load. Absence of the wallet is not enough to go on: that is also what a
  // first visit looks like.
  demoRemoved: 'sd:demoRemoved',
};

const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'JNJ', 'KO', 'O'];

/**
 * A worked example, so a first visit lands on something rather than on a form.
 *
 * Every tab in the wallet view needs holdings to say anything at all, and half
 * of them need purchase dates as well: income counts from the date you bought,
 * the score line steps when a holding joins, and the goal plan measures a
 * return from the series. An empty wallet demonstrates none of it.
 *
 * The numbers are real. Cost bases are the actual close on the date given, so
 * the gains and losses are what those positions did rather than a flattering
 * invention: it is up about half overall, carried by JPM and CAT, while VICI
 * and PG are down. A demo where everything wins teaches the reader to distrust
 * the rest of the page.
 *
 * Chosen for spread rather than for taste. Eight sectors, grades from A+ to D,
 * two REITs against eight operating companies, and yields from 0.7% to 6.8%,
 * so the breakdown, the score history and the income forecast each have
 * something to show. Every one is in the scored universe, which the wide tier
 * is not, so nothing here is missing a grade.
 *
 * It is added whenever it is absent and has not been deleted, rather than only
 * on a first run. Seeding only on a first run meant anyone who had already used
 * the app never saw it, which is most of the people who would want it. Removing
 * it records that, so it stays removed.
 */
const DEMO_WALLET = {
  id: 'demo',
  name: 'Demo portfolio',
  holdings: [
    { symbol: 'MSFT', shares: 28, cost: 287.15, boughtAt: '2022-03-15' },
    { symbol: 'JNJ', shares: 35, cost: 172.55, boughtAt: '2022-06-10' },
    { symbol: 'O', shares: 111, cost: 63.09, boughtAt: '2022-09-20' },
    { symbol: 'KO', shares: 81, cost: 61.68, boughtAt: '2023-01-17' },
    { symbol: 'PG', shares: 39, cost: 153.71, boughtAt: '2023-05-09' },
    { symbol: 'XOM', shares: 38, cost: 117.49, boughtAt: '2023-09-12' },
    { symbol: 'JPM', shares: 42, cost: 167.99, boughtAt: '2024-01-16' },
    { symbol: 'CAT', shares: 14, cost: 359.07, boughtAt: '2024-05-21' },
    { symbol: 'VICI', shares: 124, cost: 32.32, boughtAt: '2024-10-08' },
    { symbol: 'ABBV', shares: 18, cost: 191.83, boughtAt: '2025-02-11' },
  ],
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing, everything still works, it just forgets */
  }
}

let counter = 0;
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

export const SYMBOL_PATTERN = /^[A-Za-z0-9.^=-]{1,20}$/;

/* ------------------------------------------------------------------ shapes */

const cleanSymbol = (s) => {
  const up = String(s ?? '').trim().toUpperCase();
  return SYMBOL_PATTERN.test(up) ? up : null;
};

/**
 * An ISO date that is real and not in the future, or null.
 *
 * The round-trip check is deliberate: `Date.parse('2025-02-30')` rolls forward
 * to 2 March rather than failing, so a typo would be stored as a date that
 * never happened and silently shift a position's income window.
 */
/**
 * A number that is genuinely present, or null.
 *
 * `Number(null)` is 0 rather than NaN, so testing after conversion turned every
 * holding saved without a cost basis into one bought at zero the next time the
 * wallet was loaded, and the table then showed the entire position as gain.
 */
export const optionalNumber = (value) => {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === '') return null;
  const num = Number(text);
  return Number.isFinite(num) && num >= 0 ? num : null;
};

export const cleanDate = (value) => {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== text) return null;
  return ms > Date.now() ? null : text;
};

function normaliseList(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const symbols = Array.isArray(raw.symbols) ? [...new Set(raw.symbols.map(cleanSymbol).filter(Boolean))] : [];
  return { id: String(raw.id || newId('list')), name: String(raw.name || 'Watchlist').slice(0, 40), symbols };
}

function normaliseWallet(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const holdings = (Array.isArray(raw.holdings) ? raw.holdings : [])
    .map((h) => {
      const symbol = cleanSymbol(h?.symbol);
      const shares = Number(h?.shares);
      if (!symbol || !Number.isFinite(shares) || shares <= 0) return null;
      return {
        symbol,
        shares,
        cost: optionalNumber(h?.cost),
        boughtAt: cleanDate(h?.boughtAt),
      };
    })
    .filter(Boolean);
  return { id: String(raw.id || newId('wal')), name: String(raw.name || 'Wallet').slice(0, 40), holdings };
}

/* -------------------------------------------------------------------- state */

export const store = {
  lists: [],
  wallets: [],
  activeListId: null,
  activeWalletId: null,
  view: 'stock', // 'stock' | 'wallet'
};

export function loadStore() {
  const storedLists = read(KEYS.lists, null);

  if (Array.isArray(storedLists) && storedLists.length) {
    store.lists = storedLists.map(normaliseList).filter(Boolean);
  } else {
    // First run after the multi-list change: fold the single old watchlist into
    // a named list so nobody loses their tickers.
    const legacy = read(KEYS.legacyList, null);
    const symbols = Array.isArray(legacy) && legacy.length ? legacy : DEFAULT_SYMBOLS;
    store.lists = [normaliseList({ name: 'My watchlist', symbols })];
  }
  if (!store.lists.length) store.lists = [normaliseList({ name: 'My watchlist', symbols: DEFAULT_SYMBOLS })];

  const storedWallets = read(KEYS.wallets, null);
  store.wallets = (Array.isArray(storedWallets) ? storedWallets : []).map(normaliseWallet).filter(Boolean);

  // Added alongside whatever is already there, not instead of it. Someone with
  // their own wallets still gets the worked example, and it goes last so their
  // own stay at the top of the list.
  const removed = read(KEYS.demoRemoved, false) === true;
  if (!removed && !store.wallets.some((wallet) => wallet.id === DEMO_WALLET.id)) {
    store.wallets.push(normaliseWallet(DEMO_WALLET));
  }

  const activeList = read(KEYS.activeList, null);
  store.activeListId = store.lists.some((l) => l.id === activeList) ? activeList : store.lists[0].id;

  const activeWallet = read(KEYS.activeWallet, null);
  store.activeWalletId = store.wallets.some((w) => w.id === activeWallet) ? activeWallet : store.wallets[0]?.id ?? null;

  const view = read(KEYS.view, 'stock');
  store.view = ['screener', 'map', 'compare'].includes(view)
    ? view
    : view === 'wallet' && store.activeWalletId
      ? 'wallet'
      : 'stock';

  return store;
}

export function saveLists() {
  write(KEYS.lists, store.lists);
  write(KEYS.activeList, store.activeListId);
}

export function saveWallets() {
  write(KEYS.wallets, store.wallets);
  write(KEYS.activeWallet, store.activeWalletId);
}

export function saveView() {
  write(KEYS.view, store.view);
}

/* ------------------------------------------------------------------- lists */

export const activeList = () => store.lists.find((l) => l.id === store.activeListId) ?? store.lists[0];

export function createList(name) {
  const list = normaliseList({ name: name || `Watchlist ${store.lists.length + 1}`, symbols: [] });
  store.lists.push(list);
  store.activeListId = list.id;
  saveLists();
  return list;
}

export function renameList(id, name) {
  const list = store.lists.find((l) => l.id === id);
  if (!list || !name?.trim()) return;
  list.name = name.trim().slice(0, 40);
  saveLists();
}

export function deleteList(id) {
  // Never leave the sidebar with nothing in it.
  if (store.lists.length <= 1) return false;
  store.lists = store.lists.filter((l) => l.id !== id);
  if (store.activeListId === id) store.activeListId = store.lists[0].id;
  saveLists();
  return true;
}

export function addToList(symbol, listId = store.activeListId) {
  const list = store.lists.find((l) => l.id === listId);
  const clean = cleanSymbol(symbol);
  if (!list || !clean) return false;
  if (!list.symbols.includes(clean)) {
    list.symbols = [clean, ...list.symbols];
    saveLists();
  }
  return true;
}

export function removeFromList(symbol, listId = store.activeListId) {
  const list = store.lists.find((l) => l.id === listId);
  if (!list) return;
  list.symbols = list.symbols.filter((s) => s !== symbol);
  saveLists();
}

/* ----------------------------------------------------------------- wallets */

export const activeWallet = () => store.wallets.find((w) => w.id === store.activeWalletId) ?? null;

export function createWallet(name) {
  const wallet = normaliseWallet({ name: name || `Wallet ${store.wallets.length + 1}`, holdings: [] });
  store.wallets.push(wallet);
  store.activeWalletId = wallet.id;
  saveWallets();
  return wallet;
}

export function renameWallet(id, name) {
  const wallet = store.wallets.find((w) => w.id === id);
  if (!wallet || !name?.trim()) return;
  wallet.name = name.trim().slice(0, 40);
  saveWallets();
}

export function deleteWallet(id) {
  // Deleting the demo is remembered, or it reappears on the next load.
  if (id === DEMO_WALLET.id) write(KEYS.demoRemoved, true);
  store.wallets = store.wallets.filter((w) => w.id !== id);
  if (store.activeWalletId === id) store.activeWalletId = store.wallets[0]?.id ?? null;
  if (!store.activeWalletId) store.view = 'stock';
  saveWallets();
  saveView();
}

/** Adding a symbol that is already held tops up the position rather than duplicating it. */
export function upsertHolding(walletId, { symbol, shares, cost, boughtAt }) {
  const wallet = store.wallets.find((w) => w.id === walletId);
  const clean = cleanSymbol(symbol);
  const qty = Number(shares);
  if (!wallet || !clean || !Number.isFinite(qty) || qty <= 0) return false;

  const price = optionalNumber(cost);
  const bought = cleanDate(boughtAt);
  const existing = wallet.holdings.find((h) => h.symbol === clean);

  if (existing) {
    // Weighted-average the cost basis across the old and new lots, so topping
    // up a position reports the blended price actually paid.
    const totalShares = existing.shares + qty;
    if (existing.cost != null && price != null) {
      existing.cost = (existing.cost * existing.shares + price * qty) / totalShares;
    } else if (price != null) {
      existing.cost = price;
    }
    existing.shares = totalShares;
    // Keep the earliest date, because that is when the position began. Income
    // then counts every payment the position has seen, on today's share count
    // throughout. Without a lot ledger one of the two has to be approximate,
    // and the wallet view says which.
    const dates = [existing.boughtAt, bought].filter(Boolean).sort();
    existing.boughtAt = dates[0] ?? null;
  } else {
    wallet.holdings.push({ symbol: clean, shares: qty, cost: price, boughtAt: bought });
  }

  saveWallets();
  return true;
}

export function updateHolding(walletId, symbol, { shares, cost, boughtAt }) {
  const wallet = store.wallets.find((w) => w.id === walletId);
  const holding = wallet?.holdings.find((h) => h.symbol === symbol);
  if (!holding) return false;

  const qty = Number(shares);
  if (Number.isFinite(qty) && qty > 0) holding.shares = qty;
  holding.cost = optionalNumber(cost);
  holding.boughtAt = cleanDate(boughtAt);

  saveWallets();
  return true;
}

export function removeHolding(walletId, symbol) {
  const wallet = store.wallets.find((w) => w.id === walletId);
  if (!wallet) return;
  wallet.holdings = wallet.holdings.filter((h) => h.symbol !== symbol);
  saveWallets();
}

/**
 * The query string `/api/portfolio` expects: `SYMBOL:shares:cost:boughtAt`.
 *
 * The cost slot is held open when a date is given without one, so the date
 * lands in the fourth field rather than being read as a cost basis.
 */
export const holdingsParam = (wallet) =>
  (wallet?.holdings ?? [])
    .map((h) => {
      const parts = [h.symbol, h.shares];
      if (h.cost != null || h.boughtAt) parts.push(h.cost ?? '');
      if (h.boughtAt) parts.push(h.boughtAt);
      return parts.join(':');
    })
    .join(',');
