/** Thin wrapper over the server's /api routes. */

async function get(path, params = {}, { signal } = {}) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, value);
  }

  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Server returned ${res.status}`);
  }
  if (!res.ok) throw new Error(body?.error || `Server returned ${res.status}`);
  return body;
}

export const searchSymbols = (q, opts) => get('/api/search', { q }, opts).then((r) => r.results);
export const fetchQuotes = (symbols, opts) =>
  symbols.length ? get('/api/quotes', { symbols: symbols.join(',') }, opts).then((r) => r.quotes) : Promise.resolve([]);
export const fetchChart = (symbol, range, opts) => get('/api/chart', { symbol, range }, opts);
export const fetchStock = (symbol, range, period, opts) => get('/api/stock', { symbol, range, period }, opts);
export const fetchMarket = (opts) => get('/api/market', {}, opts).then((r) => r.indices);
export const fetchPortfolio = (holdings, range, opts) => get('/api/portfolio', { holdings, range }, opts);
export const fetchScreener = (basis, sector, opts) => get('/api/screener', { basis, sector }, opts);
export const fetchHealth = (opts) => get('/api/health', {}, opts);
export const fetchMap = (opts) => get('/api/map', {}, opts);
