/**
 * Stock dashboard server.
 *
 * Two jobs, no dependencies:
 *  1. Serve the static dashboard out of ./public
 *  2. Proxy Yahoo Finance, the browser cannot call it directly (CORS), and
 *     routing through here lets us cache, so a dashboard full of tickers makes
 *     a handful of upstream requests rather than dozens.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as yahoo from './lib/yahoo.js';
import { UpstreamError } from './lib/yahoo.js';
import { buildProfile, dividendsByYear, quoteFromChart } from './lib/profile.js';
import { buildScore } from './lib/score.js';
import { multipleSeries, valuationContext } from './lib/valuation.js';
import { parseHoldings, buildValueSeries, priceHoldings } from './lib/portfolio.js';
import { buildIncome, buildIncomeProjection } from './lib/income.js';
import { buildComparison } from './lib/compare.js';
import { buildScoreHistory } from './lib/scoreHistory.js';
import { gradePortfolios, gradesAsOf, GRADE_ORDER } from './lib/gradeStudy.js';
import { buildPortfolioScoreHistory } from './lib/portfolioScore.js';
import { findDips } from './lib/dips.js';
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

/** `2024-01-31` plus n days, as an ISO date. */
function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every tracked company, graded at each of its past year ends.
 *
 * Shared by the grade study and by a wallet's score history, and cached for six
 * hours because it only changes when the pipeline lands new statements. Grading
 * five hundred companies across every reporting period they have takes about
 * 800ms, which is fine once and not fine per request.
 */
function gradeTimelines() {
  return cached('grades:timelines', 6 * 60 * 60_000, async () => {
    const { securities, financials, dividends } = await warehouse.scoringInputs();
    const closes = await warehouse.monthlyHistory(
      securities.map((s) => s.symbol),
      { years: 25 },
    );

    const out = new Map();
    for (const security of securities) {
      const rows = financials.get(security.symbol);
      if (!rows?.length) continue;
      const history = buildScoreHistory({
        summary: { summaryProfile: { industry: security.industry } },
        financials: rows,
        dividendPayments: dividends.get(security.symbol) ?? [],
        closes: closes.get(security.symbol) ?? [],
        periodType: 'annual',
      });
      // Oldest first, so "the latest period that had closed" is a scan.
      if (history.periods.length) out.set(security.symbol, [...history.periods].reverse());
    }
    return out;
  });
}

/* ------------------------------------------------------------------- routes */

const routes = {
  /** Liveness for a platform health check, deliberately touches no upstream. */
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
      throw new UpstreamError('The warehouse has not been built yet, run the pipeline first.', 503);
    }

    const rows = await warehouse.screener();
    const basis = url.searchParams.get('basis');
    const sector = url.searchParams.get('sector');
    const index = url.searchParams.get('index');

    const filtered = rows.filter(
      (row) =>
        (!basis || basis === 'all' || row.scoring_basis === basis) &&
        (!sector || sector === 'all' || row.sector === sector) &&
        (!index || index === 'all' || (row.indexes ?? []).includes(index)),
    );

    /*
     * How much of the chosen index the screener can actually cover.
     *
     * Only the deep tier carries financial statements, and without statements
     * there is no score and nothing to rank. So the Nasdaq screens on the 160
     * of its 4,328 companies that are also in the S&P 500, and the Russell 2000
     * screens on none at all. Reporting both numbers is the difference between
     * a filtered list and a misleading one: a reader who asked for the Nasdaq
     * and got 160 rows should be told why, not left to assume that is the
     * Nasdaq.
     */
    const membership = await warehouse.indexSizes();
    const coverage = index && index !== 'all'
      ? { index, scored: filtered.length, members: membership.get(index) ?? null }
      : null;

    return {
      rows: filtered,
      sectors: [...new Set(rows.map((r) => r.sector).filter(Boolean))].sort(),
      indexes: [...membership.keys()].sort(),
      coverage,
      total: rows.length,
    };
  },

  /** Treemap data: market cap for size, the last session's move for colour. */
  async '/api/map'() {
    if (!warehouse.isReady()) {
      throw new UpstreamError('The warehouse has not been built yet, run the pipeline first.', 503);
    }
    const rows = await warehouse.marketMap();

    // Grouped server-side so the client receives the shape it draws, rather
    // than re-deriving the same grouping on every repaint.
    const sectors = new Map();
    for (const row of rows) {
      if (!sectors.has(row.sector)) sectors.set(row.sector, { sector: row.sector, marketCap: 0, children: [] });
      const group = sectors.get(row.sector);
      group.marketCap += row.market_cap ?? 0;
      group.children.push(row);
    }

    return {
      sectors: [...sectors.values()].sort((a, b) => b.marketCap - a.marketCap),
      total: rows.length,
      totalMarketCap: rows.reduce((sum, r) => sum + (r.market_cap ?? 0), 0),
      asOf: rows[0]?.trade_date ?? null,
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
    // upstream rate-limits by IP, it is routine, and the difference between a
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

    /*
     * Where this company's multiple sits against its own past and its peers.
     *
     * Best-effort on purpose. It needs stored price history and a peer pool,
     * so a symbol outside the tracked universe has neither, and the valuation
     * pillar falls back to the absolute band rather than the page failing.
     */
    const valuation = warehouse.isReady()
      ? await warehouse
          .valuationInputs(symbol)
          .then((inputs) => {
            const series = multipleSeries(inputs.prices, inputs.earnings);
            // The latest close, not the last month-end: "is it expensive today"
            // wants today's price. The peer pool is built the same way, so the
            // company and the group it is measured against are on one basis.
            const current = inputs.peers.find((p) => p.symbol === symbol)?.multiple ?? null;
            return valuationContext({
              series,
              current,
              self: {
                symbol,
                multiple: current,
                industry: inputs.self?.industry ?? null,
                sector: inputs.self?.sector ?? null,
                isReit: Boolean(inputs.self?.is_reit),
              },
              peers: inputs.peers,
            });
          })
          .catch(() => null)
      : null;

    // Scoring needs the statements; without them there is nothing to grade.
    const score =
      Object.keys(summary).length && annual.length
        ? buildScore({ summary, financials: annual, dividendPayments, valuation })
        : null;

    /*
     * Score as at each past period, with the return over it.
     *
     * Monthly closes rather than the chart's: the chart follows whatever range
     * the reader picked, and a 1D chart cannot price a period end from three
     * years ago. The long history is already fetched above for the dividend
     * record, so this costs nothing extra; the warehouse covers it when the
     * upstream is rate-limiting.
     */
    let closes = live.history?.points ?? [];
    if (!closes.length && warehouse.isReady()) {
      closes = await warehouse
        .monthlyHistory([symbol], { years: 12 })
        .then((m) => m.get(symbol) ?? [])
        .catch(() => []);
    }

    // Quarterly statements are fetched only when the reader is looking at them;
    // an annual view would otherwise pay for a request it never renders.
    const quarterlyRows =
      period === 'quarterly'
        ? financials
        : await cached(`fin:${symbol}:quarterly`, TTL.financials, () => yahoo.getFinancials(symbol, 'quarterly'))
            .catch(() => (warehouse.isReady() ? warehouse.securityBundle(symbol, { period: 'quarterly' }).then((b) => b?.financials ?? []).catch(() => []) : []));

    const historyInput = { summary, dividendPayments, closes };
    const scoreHistory =
      annual.length && closes.length
        ? {
            annual: buildScoreHistory({ ...historyInput, financials: annual, periodType: 'annual' }),
            quarterly: buildScoreHistory({ ...historyInput, financials: quarterlyRows ?? [], periodType: 'quarterly' }),
          }
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
      scoreHistory,
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
    // Daily closes from the warehouse, so a missing live quote does not also
    // cost the day change. Only consulted when the quote call failed.
    const storedCloses = !quotes.length && warehouse.isReady()
      ? await warehouse
          .latestPrices(symbols)
          .then((rows) => new Map(rows.map((row) => [row.symbol, row])))
          .catch(() => new Map())
      : new Map();

    const fallbackQuotes = entries
      .map((e) => quoteFromChart(e.chart, storedCloses.get(e.holding.symbol)))
      .filter(Boolean);

    const { rows, totals } = priceHoldings(holdings, quotes.length ? quotes : fallbackQuotes);
    const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))];

    return {
      range,
      points: series.points,
      startedAt: series.startedAt,
      startReason: series.startReason,
      firstPurchase: series.firstPurchase,
      contributions: series.contributions,
      holdings: rows,
      totals,
      currency: currencies[0] ?? 'USD',
      // Values are summed as reported; nothing here converts between currencies.
      mixedCurrency: currencies.length > 1,
      unpriced: series.coverage.filter((c) => !c.priced).map((c) => c.symbol),
    };
  },

  /**
   * Dividend income a wallet has actually received.
   *
   * The warehouse answers this for tracked names without a single upstream
   * call, which matters because it is a per-symbol dividend history and doing
   * it live would be one request per holding on every page load. Anything
   * outside the tracked universe falls back to Yahoo, so a wallet holding a
   * mid-cap the index does not carry still reports its income.
   */
  async '/api/portfolio/income'(url) {
    const holdings = parseHoldings(url.searchParams.get('holdings'));
    if (!holdings.length) throw new UpstreamError('At least one holding is required', 400);

    const symbols = holdings.map((h) => h.symbol);
    const stored = warehouse.isReady() ? await warehouse.dividendsFor(symbols) : new Map();

    // Only the gaps go upstream, and a failure on one symbol drops that symbol
    // from the total rather than failing the request: a partial income record
    // that names what is missing beats no income record at all.
    const missing = symbols.filter((symbol) => !stored.has(symbol));
    const fetched = await Promise.allSettled(
      missing.map((symbol) =>
        cached(`longhistory:${symbol}`, TTL.financials, () => yahoo.getLongHistory(symbol, 20)),
      ),
    );

    const unavailable = [];
    missing.forEach((symbol, i) => {
      const result = fetched[i];
      if (result.status !== 'fulfilled') {
        unavailable.push(symbol);
        return;
      }
      stored.set(
        symbol,
        (result.value.dividends ?? [])
          .map((d) => ({ exDate: new Date(d.t).toISOString().slice(0, 10), perShare: d.amount }))
          .sort((a, b) => a.exDate.localeCompare(b.exDate)),
      );
    });

    // Clamped rather than trusted: the horizon comes off a query string, and a
    // projection is only arithmetic, so nothing stops it running to 10,000
    // years and producing a number with no meaning attached to it.
    const years = Math.min(30, Math.max(1, Math.round(Number(url.searchParams.get('years')) || 5)));

    const income = buildIncome(holdings, stored);
    // The forecast reads the same dividend record the received-income table
    // does, so the two can never disagree about what a holding pays.
    const projection = buildIncomeProjection(holdings, stored, { years });

    return {
      ...income,
      projection,
      unavailable,
      sources: {
        warehouse: symbols.filter((symbol) => !missing.includes(symbol)),
        live: missing.filter((symbol) => !unavailable.includes(symbol)),
      },
    };
  },

  /**
   * Rebased total-return and price-return series for up to six symbols.
   *
   * Monthly resolution throughout. The view compares multi-year shapes, and a
   * daily payload for six names is two orders of magnitude larger for a
   * difference nobody can see at this scale.
   */
  async '/api/compare'(url) {
    const symbols = [
      ...new Set(
        String(url.searchParams.get('symbols') ?? '')
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter((s) => /^[A-Z0-9.^=-]{1,20}$/.test(s)),
      ),
    ].slice(0, 6);

    if (symbols.length < 2) throw new UpstreamError('Give at least two tickers to compare', 400);

    const years = Math.min(20, Math.max(1, Number(url.searchParams.get('years')) || 10));
    const stored = warehouse.isReady() ? await warehouse.monthlyHistory(symbols, { years }) : new Map();

    const missing = symbols.filter((symbol) => !stored.has(symbol));
    const fetched = await Promise.allSettled(
      missing.map((symbol) => cached(`longhistory:${symbol}`, TTL.financials, () => yahoo.getLongHistory(symbol, years))),
    );

    const unavailable = [];
    missing.forEach((symbol, i) => {
      const result = fetched[i];
      if (result.status === 'fulfilled' && result.value.points?.length) stored.set(symbol, result.value.points);
      else unavailable.push(symbol);
    });

    // Names carried alongside the maths so the legend reads as companies rather
    // than tickers. The warehouse answers first because it needs no upstream
    // call at all; quotes only fill the gaps for symbols outside the universe.
    const names = warehouse.isReady() ? await warehouse.namesFor(symbols).catch(() => new Map()) : new Map();
    const unnamed = symbols.filter((symbol) => !names.has(symbol));
    if (unnamed.length) {
      const quotes = await cached(`quotes:${unnamed.join(',')}`, TTL.quotes, () => yahoo.getQuotes(unnamed)).catch(() => []);
      for (const q of quotes) if (q.name) names.set(q.symbol, q.name);
    }

    const comparison = buildComparison(stored);
    // Left null rather than defaulted to the ticker. A name that is just the
    // ticker again renders as "O, O", which reads as a bug because it is one.
    for (const entry of comparison.series) {
      const name = names.get(entry.symbol);
      entry.name = name && name !== entry.symbol ? name : null;
    }

    return { ...comparison, years, unavailable, requested: symbols };
  },

  /**
   * Equal-weight portfolios by grade, over several windows.
   *
   * The heavy part is grading 500 companies at every past reporting date, so
   * the timelines are built once and cached for six hours. They only change
   * when the pipeline lands new statements, which is nightly at most.
   */
  async '/api/compare/grades'(url) {
    if (!warehouse.isReady()) {
      throw new UpstreamError('The warehouse has not been built yet, run the pipeline first.', 503);
    }

    const basis = url.searchParams.get('basis') === 'now' ? 'now' : 'then';
    const windows = [1, 3, 5, 10, 20];

    const timelines = await gradeTimelines();

    const current = await cached('grades:current', 60 * 60_000, async () => {
      const rows = await warehouse.screener();
      return new Map(rows.filter((r) => r.grade).map((r) => [r.symbol, r.grade]));
    });

    const today = new Date();
    const results = [];

    for (const years of windows) {
      const start = new Date(Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate()))
        .toISOString()
        .slice(0, 10);

      const returns = await cached(`grades:returns:${start}`, 6 * 60 * 60_000, () => warehouse.returnsSince(start));

      // A window the price history does not reach is reported as such rather
      // than quietly computed over whatever fraction of it exists, which would
      // label a two-year return as twenty.
      const covered = returns.filter((r) => r.startDate <= addDays(start, 10));
      if (covered.length < 20) {
        results.push({
          years,
          available: false,
          reason: 'price history does not reach back this far',
          symbolsWithPrices: covered.length,
        });
        continue;
      }

      const grades = basis === 'now' ? current : gradesAsOf(timelines, start);
      const study = gradePortfolios(covered, grades, years);

      results.push({
        years,
        available: study.rows.length > 0,
        reason: study.rows.length ? null : 'no company could be graded as at this date',
        start,
        ...study,
      });
    }

    return {
      basis,
      windows: results,
      gradeOrder: GRADE_ORDER,
      graded: timelines.size,
      asOf: today.toISOString().slice(0, 10),
    };
  },

  /**
   * A wallet's quality score over time, weighted by what it held.
   *
   * Three things move the line and the model keeps them apart: a company
   * reporting a new year, a holding's weight drifting with its price, and a
   * holding joining on the day it was bought. The last is what makes it a
   * portfolio's score rather than a watchlist average.
   */
  async '/api/portfolio/score-history'(url) {
    const holdings = parseHoldings(url.searchParams.get('holdings'));
    if (!holdings.length) throw new UpstreamError('At least one holding is required', 400);
    if (!warehouse.isReady()) {
      throw new UpstreamError('The warehouse has not been built yet, run the pipeline first.', 503);
    }

    const symbols = holdings.map((h) => h.symbol);
    const [timelines, prices] = await Promise.all([
      gradeTimelines(),
      warehouse.monthlyHistory(symbols, { years: 25 }),
    ]);

    // Only this wallet's symbols, so the response carries no more than it needs.
    const walletTimelines = new Map(symbols.filter((symbol) => timelines.has(symbol)).map((symbol) => [symbol, timelines.get(symbol)]));

    return buildPortfolioScoreHistory({ holdings, timelines: walletTimelines, prices });
  },

  /**
   * Reference facts for a wallet's holdings, so the breakdown can group on
   * something other than the ticker.
   *
   * Values are not returned here: the client already has them from
   * /api/portfolio, and pricing the same basket twice invites the two to
   * disagree over which minute they were priced in.
   */
  async '/api/portfolio/facets'(url) {
    const symbols = String(url.searchParams.get('symbols') ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z0-9.^=-]{1,20}$/.test(s))
      .slice(0, 60);

    if (!symbols.length) throw new UpstreamError('At least one symbol is required', 400);
    if (!warehouse.isReady()) return { facets: {}, available: false };

    const facets = await warehouse.securityFacets(symbols);
    return {
      available: true,
      facets: Object.fromEntries(facets),
      // Named rather than left as silent gaps: a holding outside the tracked
      // universe has no sector here, and the breakdown says so.
      unknown: symbols.filter((symbol) => !facets.has(symbol)),
    };
  },

  /**
   * Which holdings are trading well below their own recent range.
   *
   * Answered entirely from the warehouse: a 52-week high is a scan over stored
   * closes, and doing it live would be one chart request per holding on every
   * page load for a number that changes once a day.
   */
  async '/api/portfolio/dips'(url) {
    const holdings = parseHoldings(url.searchParams.get('holdings'));
    if (!holdings.length) throw new UpstreamError('At least one holding is required', 400);
    if (!warehouse.isReady()) {
      throw new UpstreamError('The warehouse has not been built yet, run the pipeline first.', 503);
    }

    const days = Math.min(1825, Math.max(30, Math.round(Number(url.searchParams.get('days')) || 365)));
    const symbols = holdings.map((h) => h.symbol);

    const [ranges, facets] = await Promise.all([
      warehouse.priceRange(symbols, { days }),
      warehouse.securityFacets(symbols),
    ]);

    // The yield fields live on the security dimension beside the sector, so the
    // same read answers both the quality column and the income signal.
    const facts = new Map(
      [...facets.entries()].map(([symbol, fact]) => [
        symbol,
        {
          name: fact.name,
          grade: fact.grade,
          score: fact.score,
          yieldPct: fact.dividendYieldPct ?? null,
          avgYieldPct: fact.fiveYearAvgDividendYieldPct ?? null,
        },
      ]),
    );

    return findDips(holdings, ranges, facts, { windowDays: days });
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
  // Resolve inside PUBLIC_DIR only, reject anything that escapes it.
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
