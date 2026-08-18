/**
 * Persisted user state: named watchlists and wallets.
 *
 * Everything lives in localStorage — there is no account and no server-side
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
};

const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'JNJ', 'KO', 'O'];

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
    /* private browsing — everything still works, it just forgets */
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
      const cost = Number(h?.cost);
      if (!symbol || !Number.isFinite(shares) || shares <= 0) return null;
      return { symbol, shares, cost: Number.isFinite(cost) && cost >= 0 ? cost : null };
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

  store.wallets = (read(KEYS.wallets, []) ?? []).map(normaliseWallet).filter(Boolean);

  const activeList = read(KEYS.activeList, null);
  store.activeListId = store.lists.some((l) => l.id === activeList) ? activeList : store.lists[0].id;

  const activeWallet = read(KEYS.activeWallet, null);
  store.activeWalletId = store.wallets.some((w) => w.id === activeWallet) ? activeWallet : store.wallets[0]?.id ?? null;

  const view = read(KEYS.view, 'stock');
  store.view = ['screener', 'map'].includes(view)
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
  store.wallets = store.wallets.filter((w) => w.id !== id);
  if (store.activeWalletId === id) store.activeWalletId = store.wallets[0]?.id ?? null;
  if (!store.activeWalletId) store.view = 'stock';
  saveWallets();
  saveView();
}

/** Adding a symbol that is already held tops up the position rather than duplicating it. */
export function upsertHolding(walletId, { symbol, shares, cost }) {
  const wallet = store.wallets.find((w) => w.id === walletId);
  const clean = cleanSymbol(symbol);
  const qty = Number(shares);
  if (!wallet || !clean || !Number.isFinite(qty) || qty <= 0) return false;

  const basis = Number(cost);
  const price = Number.isFinite(basis) && basis >= 0 ? basis : null;
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
  } else {
    wallet.holdings.push({ symbol: clean, shares: qty, cost: price });
  }

  saveWallets();
  return true;
}

export function updateHolding(walletId, symbol, { shares, cost }) {
  const wallet = store.wallets.find((w) => w.id === walletId);
  const holding = wallet?.holdings.find((h) => h.symbol === symbol);
  if (!holding) return false;

  const qty = Number(shares);
  if (Number.isFinite(qty) && qty > 0) holding.shares = qty;
  const basis = Number(cost);
  holding.cost = Number.isFinite(basis) && basis >= 0 ? basis : null;

  saveWallets();
  return true;
}

export function removeHolding(walletId, symbol) {
  const wallet = store.wallets.find((w) => w.id === walletId);
  if (!wallet) return;
  wallet.holdings = wallet.holdings.filter((h) => h.symbol !== symbol);
  saveWallets();
}

/** The query string `/api/portfolio` expects. */
export const holdingsParam = (wallet) =>
  (wallet?.holdings ?? []).map((h) => `${h.symbol}:${h.shares}${h.cost != null ? `:${h.cost}` : ''}`).join(',');
