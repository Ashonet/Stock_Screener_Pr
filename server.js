/**
 * Stock dashboard server.
 *
 * Two jobs, no dependencies:
 *  1. Serve the static dashboard out of ./public
 *  2. Proxy Yahoo Finance — the browser cannot call it directly (CORS), and
 *     routing through here lets us cache, so a dashboard full of tickers makes
 *     a handful of upstream requests rather than dozens.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as yahoo from './lib/yahoo.js';
import { UpstreamError } from './lib/yahoo.js';
import { buildProfile, dividendsByYear } from './lib/profile.js';
import { buildScore } from './lib/score.js';
import { parseHoldings, buildValueSeries, priceHoldings } from './lib/portfolio.js';
import { cached, stats as cacheStats } from './lib/cache.js';
import * as warehouse from './lib/warehouse.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

/** Cache windows, in ms. Prices move; balance sheets do not. */
const TTL = {
  quotes: 15_000,
  intraday: 30_000,
  history: 10 * 60_000,
  profile: 15 * 60_000,
  financials: 6 * 60 * 60_000,
  search: 60 * 60_000,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const MARKET_INDICES = [
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^IXIC', label: 'Nasdaq' },
  { symbol: '^DJI', label: 'Dow Jones' },
  { symbol: '^RUT', label: 'Russell 2000' },
  { symbol: '^VIX', label: 'VIX' },
  { symbol: '^TNX', label: '10-Year yield' },
];

/* ------------------------------------------------------------------ helpers */

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Yahoo symbols are short and drawn from a fixed alphabet. Validating here
 * means nothing user-typed reaches a URL we build.
 */
function cleanSymbol(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  return /^[A-Z0-9.^=-]{1,20}$/.test(s) ? s : null;
}

function symbolList(raw, max = 60) {
  return [...new Set(String(raw ?? '').split(',').map(cleanSymbol).filter(Boolean))].slice(0, max);
}

/* ------------------------------------------------------------------- routes */

const routes = {
  /** Liveness for a platform health check — deliberately touches no upstream. */
  async '/api/health'() {
    return {
      ok: true,
      uptime: Math.round(process.uptime()),
      cache: cacheStats(),
      warehouse: await warehouse.health().catch(() => ({ available: false })),
    };
  },

  /**
   * The screener: every tracked security, scored, from the warehouse.
   *
   * This is the question the live API could not answer. Ranking 80 companies
   * on a score derived from four years of statements would have meant ~300
   * upstream calls per page load; against the mart it is one local query.
   */
  async '/api/screener'(url) {
    if (!warehouse.isReady()) {
      throw new UpstreamError('The warehouse has not been built yet — run the pipeline first.', 503);
    }

    const rows = await warehouse.screener();
    const basis = url.searchParams.get('basis');
    const sector = url.searchParams.get('sector');

    const filtered = rows.filter(
      (row) =>
        (!basis || basis === 'all' || row.scoring_basis === basis) &&
        (!sector || sector === 'all' || row.sector === sector),
    );

    return {
      rows: filtered,
      sectors: [...new Set(rows.map((r) => r.sector).filter(Boolean))].sort(),
      total: rows.length,
    };
  },

  async '/api/sectors'() {
    if (!warehouse.isReady()) throw new UpstreamError('The warehouse has not been built yet.', 503);
    return { sectors: await warehouse.sectorSummary() };
  },

  async '/api/search'(url) {
    const q = String(url.searchParams.get('q') ?? '').trim().slice(0, 60);
    if (q.length < 1) return { results: [] };
    const results = await cached(`search:${q.toLowerCase()}`, TTL.search, () => yahoo.search(q));
    return { results };
  },

  async '/api/quotes'(url) {
    const symbols = symbolList(url.searchParams.get('symbols'));
    if (!symbols.length) return { quotes: [] };

    const key = `quotes:${symbols.join(',')}`;
    const quotes = await cached(key, TTL.quotes, async () => {
      try {
        return await yahoo.getQuotes(symbols);
      } catch {
        // The session-gated quote endpoint is the only place we need a crumb for
        // watchlist rows. If it is unavailable, fall back to chart metadata,
        // which carries the same price fields and needs no session.
        const settled = await Promise.allSettled(symbols.map((s) => yahoo.getChart(s, '1d')));
        return settled
          .filter((r) => r.status === 'fulfilled')
          .map((r) => r.value)
          .map((c) => ({
            symbol: c.symbol,
            name: c.name,
            currency: c.currency,
            exchange: c.exchange,
            quoteType: c.instrumentType,
            price: c.price,
            previousClose: c.previousClose,
            change: c.price != null && c.previousClose != null ? c.price - c.previousClose : null,
            changePercent:
              c.price != null && c.previousClose ? ((c.price - c.previousClose) / c.previousClose) * 100 : null,
            fiftyTwoWeekHigh: c.fiftyTwoWeekHigh,
            fiftyTwoWeekLow: c.fiftyTwoWeekLow,
            volume: c.volume,
            marketTime: c.marketTime,
          }));
      }
    });
    return { quotes };
  },

  async '/api/chart'(url) {
    const symbol = cleanSymbol(url.searchParams.get('symbol'));
    if (!symbol) throw new UpstreamError('A valid symbol is required', 400);
    const range = url.searchParams.get('range') ?? '1y';
    if (!yahoo.isValidRange(range)) throw new UpstreamError(`Unsupported range: ${range}`, 400);

    const ttl = range === '1d' || range === '5d' ? TTL.intraday : TTL.history;
    return cached(`chart:${symbol}:${range}`, ttl, () => yahoo.getChart(symbol, range));
  },

  /** Everything the detail view needs for one ticker, in a single round trip. */
  async '/api/stock'(url) {
    const symbol = cleanSymbol(url.searchParams.get('symbol'));
    if (!symbol) throw new UpstreamError('A valid symbol is required', 400);
    const period = url.searchParams.get('period') === 'quarterly' ? 'quarterly' : 'annual';
    const range = url.searchParams.get('range') ?? '1y';
    if (!yahoo.isValidRange(range)) throw new UpstreamError(`Unsupported range: ${range}`, 400);

    // Price history is the only hard requirement; it also validates the symbol.
    const chart = await cached(
      `chart:${symbol}:${range}`,
      range === '1d' || range === '5d' ? TTL.intraday : TTL.history,
      () => yahoo.getChart(symbol, range),
    );

    // The rest is session-gated and enriches the view. Settle them independently
    // so one upstream hiccup degrades a panel instead of the whole page.
    const [summaryRes, financialsRes, annualRes, historyRes] = await Promise.allSettled([
      cached(`summary:${symbol}`, TTL.profile, () => yahoo.getSummary(symbol)),
      cached(`fin:${symbol}:${period}`, TTL.financials, () => yahoo.getFinancials(symbol, period)),
      // The scorer always reasons on full financial years, whichever period the
      // chart is showing. When period is already annual this is the same cache
      // entry, so it costs nothing.
      cached(`fin:${symbol}:annual`, TTL.financials, () => yahoo.getFinancials(symbol, 'annual')),
      // Long history: the complete dividend record plus monthly closes.
      cached(`history:${symbol}`, TTL.financials, () => yahoo.getLongHistory(symbol)),
    ]);

    const live = {
      summary: summaryRes.status === 'fulfilled' ? summaryRes.value : null,
      financials: financialsRes.status === 'fulfilled' ? financialsRes.value : null,
      annual: annualRes.status === 'fulfilled' ? annualRes.value : null,
      history: historyRes.status === 'fulfilled' ? historyRes.value : null,
    };

    // Fall back to stored data when the session-gated endpoints are
    // unavailable. On a laptop that is occasional; on a shared host, where the
    // upstream rate-limits by IP, it is routine — and the difference between a
    // page of dashes and a page of slightly stale numbers is the whole point of
    // having a warehouse. Each piece falls back independently, so a live
    // statement set is still used even if the profile call failed.
    let stored = null;
    const needsFallback = !live.summary || !live.financials || !live.annual;
    if (needsFallback && warehouse.isReady()) {
      stored = await warehouse.securityBundle(symbol, { period }).catch(() => null);
      if (stored && period !== 'annual') {
        stored.annual = await warehouse
          .securityBundle(symbol, { period: 'annual' })
          .then((b) => b?.financials ?? null)
          .catch(() => null);
      }
    }

    const summary = live.summary ?? stored?.summary ?? {};
    const financials = live.financials ?? stored?.financials ?? [];
    const annual = live.annual ?? (period === 'annual' ? stored?.financials : stored?.annual) ?? [];
    const dividendPayments =
      live.history?.dividends ?? stored?.dividendPayments ?? chart.dividends ?? [];

    const profile = buildProfile(symbol, summary, chart);
    const dividends = dividendsByYear(dividendPayments);

    // Scoring needs the statements; without them there is nothing to grade.
    const score =
      Object.keys(summary).length && annual.length
        ? buildScore({ summary, financials: annual, dividendPayments })
        : null;

    // Report what is stale rather than what failed: a reader cares that the
    // numbers are from Friday, not which endpoint returned 429.
    const servedFromWarehouse = [];
    if (!live.summary && stored?.summary) servedFromWarehouse.push('fundamentals');
    if (!live.financials && stored?.financials?.length) servedFromWarehouse.push('financials');

    const degraded = [];
    if (!live.summary && !stored?.summary) degraded.push('fundamentals');
    if (!live.financials && !stored?.financials?.length) degraded.push('financials');

    return {
      ...profile,
      chart,
      financials,
      financialsPeriod: period,
      dividends,
      score,
      degraded,
      servedFromWarehouse,
      warehouseAsOf: servedFromWarehouse.length ? (stored?.priceAsOf ?? stored?.asOf ?? null) : null,
    };
  },

  /** A wallet's combined value history plus its priced holdings. */
  async '/api/portfolio'(url) {
    const holdings = parseHoldings(url.searchParams.get('holdings'));
    if (!holdings.length) throw new UpstreamError('At least one holding is required', 400);
    const range = url.searchParams.get('range') ?? '1y';
    if (!yahoo.isValidRange(range)) throw new UpstreamError(`Unsupported range: ${range}`, 400);

    const chartTtl = range === '1d' || range === '5d' ? TTL.intraday : TTL.history;
    const symbols = holdings.map((h) => h.symbol);

    // Both halves come out of the same per-symbol caches the rest of the
    // dashboard fills, so a wallet of names you are already watching is nearly
    // free.
    const [charts, quotes] = await Promise.all([
      Promise.allSettled(
        holdings.map((h) => cached(`chart:${h.symbol}:${range}`, chartTtl, () => yahoo.getChart(h.symbol, range))),
      ),
      cached(`quotes:${symbols.join(',')}`, TTL.quotes, () => yahoo.getQuotes(symbols)).catch(() => []),
    ]);

    const entries = holdings.map((holding, i) => ({
      holding,
      chart: charts[i].status === 'fulfilled' ? charts[i].value : null,
    }));

    const series = buildValueSeries(entries);
    // Quotes are the crumb-gated endpoint; if it is unavailable, fall back to
    // the last close from each chart so the wallet still totals up.
    const fallbackQuotes = entries
      .filter((e) => e.chart)
      .map((e) => ({
        symbol: e.chart.symbol,
        name: e.chart.name,
        currency: e.chart.currency,
        price: e.chart.price,
        previousClose: e.chart.previousClose,
        change: e.chart.price != null && e.chart.previousClose != null ? e.chart.price - e.chart.previousClose : null,
        changePercent:
          e.chart.price != null && e.chart.previousClose
            ? ((e.chart.price - e.chart.previousClose) / e.chart.previousClose) * 100
            : null,
      }));

    const { rows, totals } = priceHoldings(holdings, quotes.length ? quotes : fallbackQuotes);
    const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))];

    return {
      range,
      points: series.points,
      startedAt: series.startedAt,
      holdings: rows,
      totals,
      currency: currencies[0] ?? 'USD',
      // Values are summed as reported; nothing here converts between currencies.
      mixedCurrency: currencies.length > 1,
      unpriced: series.coverage.filter((c) => !c.priced).map((c) => c.symbol),
    };
  },

  async '/api/market'() {
    const symbols = MARKET_INDICES.map((i) => i.symbol);
    const quotes = await cached(`quotes:${symbols.join(',')}`, TTL.quotes, async () => {
      try {
        return await yahoo.getQuotes(symbols);
      } catch {
        const settled = await Promise.allSettled(symbols.map((s) => yahoo.getChart(s, '1d')));
        return settled
          .filter((r) => r.status === 'fulfilled')
          .map((r) => r.value)
          .map((c) => ({
            symbol: c.symbol,
            name: c.name,
            price: c.price,
            previousClose: c.previousClose,
            change: c.price != null && c.previousClose != null ? c.price - c.previousClose : null,
            changePercent:
              c.price != null && c.previousClose ? ((c.price - c.previousClose) / c.previousClose) * 100 : null,
          }));
      }
    });

    const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
    return {
      indices: MARKET_INDICES.map(({ symbol, label }) => ({
        symbol,
        label,
        ...(bySymbol.get(symbol) ?? { price: null, change: null, changePercent: null }),
      })),
    };
  },
};

/* --------------------------------------------------------------- static files */

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  // Resolve inside PUBLIC_DIR only — reject anything that escapes it.
  const target = normalize(join(PUBLIC_DIR, rel));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) return serveStatic(req, res, join(pathname, 'index.html'));

    const body = await readFile(target);
    const ext = extname(target).toLowerCase();

    // The page and its modules are versioned together but have no fingerprinted
    // URLs, so a browser holding one and fetching the other produces a mismatch:
    // the script looks for elements the markup no longer has, or the reverse.
    // `no-cache` only asks for revalidation, which a module cache can skip.
    // These files are a few hundred KB on a self-hosted dashboard, so refetching
    // them costs nothing next to the confusion of a half-stale page.
    const volatile = ext === '.html' || ext === '.js' || ext === '.css';

    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': volatile ? 'no-store, must-revalidate' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

/* ------------------------------------------------------------------- server */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? HOST}`);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  const handler = routes[url.pathname];
  if (handler) {
    try {
      sendJSON(res, 200, await handler(url));
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status : 500;
      if (status >= 500) console.error(`[${url.pathname}]`, err.message);
      sendJSON(res, status, { error: err.message || 'Request failed' });
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'Unknown endpoint' });

  await serveStatic(req, res, url.pathname);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start on another one:  PORT=5174 npm start`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Stock dashboard running at  http://${HOST}:${PORT}\n`);
  console.log('  Data: Yahoo Finance public endpoints (no API key required)');
  console.log('  Stop: Ctrl+C\n');
});
