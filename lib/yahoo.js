/**
 * Yahoo Finance client.
 *
 * No API key and no signup: the public endpoints are used directly. Two of them
 * (quote, quoteSummary, fundamentals-timeseries) require a session, a consent
 * cookie plus a matching "crumb" token, so `session()` establishes one lazily
 * and `authFetch()` re-establishes it if the token goes stale.
 *
 * Endpoints that need no session at all (chart, search) go through `plainFetch`,
 * so the dashboard still renders prices even if the crumb handshake fails.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const TIMEOUT_MS = 12_000;

export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

async function request(url, { headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*', ...headers },
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new UpstreamError('Yahoo Finance timed out', 504);
    throw new UpstreamError(`Could not reach Yahoo Finance: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function plainFetch(url, { notFound, retry = true } = {}) {
  const res = await request(url);

  // Yahoo rate-limits by IP. On a laptop that essentially never fires; on a
  // shared host it is the failure you actually hit, so back off once before
  // giving up. The session-gated path has its own retry in authFetch.
  if (res.status === 429 && retry) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    return plainFetch(url, { notFound, retry: false });
  }

  if (res.status === 404) throw new UpstreamError(notFound ?? 'Not found on Yahoo Finance', 404);
  if (res.status === 429) throw new UpstreamError('Yahoo Finance is rate-limiting this server, try again shortly', 429);
  if (!res.ok) throw new UpstreamError(`Yahoo Finance returned ${res.status}`, 502);
  return res.json();
}

/* ------------------------------------------------------------------ session */

let sessionPromise = null;

async function newSession() {
  // Any Yahoo host will set the consent cookie; fc.yahoo.com answers 404 but
  // still hands one out, which makes it the cheapest way to get it.
  const res = await request('https://fc.yahoo.com/');
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')];
  const cookie = raw
    .filter(Boolean)
    .map((c) => c.split(';')[0])
    .join('; ');
  if (!cookie) throw new UpstreamError('Yahoo Finance did not issue a session cookie');

  const crumbRes = await request('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { cookie } });
  const crumb = (await crumbRes.text()).trim();
  // A valid crumb is a short opaque token; an HTML error page is not.
  if (!crumb || crumb.length > 32 || crumb.includes('<')) {
    throw new UpstreamError('Yahoo Finance did not issue a session token');
  }
  return { cookie, crumb };
}

function session() {
  if (!sessionPromise) {
    sessionPromise = newSession().catch((err) => {
      sessionPromise = null; // let the next caller retry rather than caching the failure
      throw err;
    });
  }
  return sessionPromise;
}

/** Fetch a session-gated endpoint, retrying once with a fresh crumb. */
async function authFetch(buildUrl, { retry = true } = {}) {
  const { cookie, crumb } = await session();
  const res = await request(buildUrl(crumb), { headers: { cookie } });

  if ((res.status === 401 || res.status === 403 || res.status === 429) && retry) {
    sessionPromise = null;
    return authFetch(buildUrl, { retry: false });
  }
  if (!res.ok) throw new UpstreamError(`Yahoo Finance returned ${res.status}`, res.status === 404 ? 404 : 502);
  return res.json();
}

/* ------------------------------------------------------------- value helpers */

/** Yahoo wraps most numbers as `{ raw, fmt }`. Reduce to a plain number or null. */
export function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && 'raw' in v) {
    const n = Number(v.raw);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/* ------------------------------------------------------------------ endpoints */

const RANGES = {
  '1d': { range: '1d', interval: '5m' },
  '5d': { range: '5d', interval: '30m' },
  '1mo': { range: '1mo', interval: '1d' },
  '6mo': { range: '6mo', interval: '1d' },
  ytd: { range: 'ytd', interval: '1d' },
  '1y': { range: '1y', interval: '1d' },
  '5y': { range: '5y', interval: '1wk' },
  max: { range: 'max', interval: '1mo' },
};

export const isValidRange = (r) => Object.hasOwn(RANGES, r);

function parseDividends(result) {
  return Object.values(result?.events?.dividends ?? {})
    .map((d) => ({ t: (num(d.date) ?? 0) * 1000, amount: num(d.amount) ?? 0 }))
    .filter((d) => d.t > 0 && d.amount > 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Price history plus the quote fields Yahoo bundles into the chart metadata.
 * Needs no session, so this is the dashboard's dependable floor.
 */
export async function getChart(symbol, rangeKey = '1y') {
  const { range, interval } = RANGES[rangeKey] ?? RANGES['1y'];
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}&events=div%2Csplit&includePrePost=false`;
  const json = await plainFetch(url, {
    notFound: `No security found for "${symbol}", check the ticker.`,
  });

  const err = json?.chart?.error;
  if (err) throw new UpstreamError(err.description || `Unknown symbol: ${symbol}`, 404);

  const result = json?.chart?.result?.[0];
  if (!result) throw new UpstreamError(`No data for ${symbol}`, 404);

  const meta = result.meta ?? {};
  const stamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose ?? null;
  const volumes = result.indicators?.quote?.[0]?.volume ?? [];

  const points = [];
  for (let i = 0; i < stamps.length; i++) {
    const close = num(closes[i]) ?? num(adjusted?.[i]);
    if (close == null) continue; // Yahoo pads gaps with nulls: drop them, never zero-fill
    points.push({ t: stamps[i] * 1000, c: close, v: num(volumes[i]) ?? 0 });
  }

  const dividends = parseDividends(result);

  return {
    symbol: meta.symbol ?? symbol.toUpperCase(),
    name: str(meta.longName) ?? str(meta.shortName) ?? meta.symbol ?? symbol.toUpperCase(),
    currency: meta.currency ?? 'USD',
    exchange: str(meta.fullExchangeName) ?? str(meta.exchangeName),
    instrumentType: meta.instrumentType ?? 'EQUITY',
    price: num(meta.regularMarketPrice),
    previousClose: num(meta.chartPreviousClose) ?? num(meta.previousClose),
    dayHigh: num(meta.regularMarketDayHigh),
    dayLow: num(meta.regularMarketDayLow),
    fiftyTwoWeekHigh: num(meta.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(meta.fiftyTwoWeekLow),
    volume: num(meta.regularMarketVolume),
    marketTime: num(meta.regularMarketTime) ? num(meta.regularMarketTime) * 1000 : null,
    gmtOffset: num(meta.gmtoffset) ?? 0,
    range: rangeKey,
    interval,
    points,
    dividends,
  };
}

/**
 * Long history over an explicit date window: the dividend record plus monthly
 * closes, both raw and dividend-adjusted.
 *
 * Deliberately not `range=max`: on that range Yahoo caps the event list at 168
 * entries and drops the *middle* of it, so a long-paying name like KO comes
 * back with 1962-2003 and then the current year, with two decades missing. An
 * explicit period window returns the events complete.
 *
 * Monthly bars are enough for multi-year return maths and cut the payload to a
 * third of the weekly equivalent; the dividend totals are identical across the
 * window the dashboard actually charts.
 */
export async function getLongHistory(symbol, years = 20) {
  const now = Math.floor(Date.now() / 1000);
  const period1 = now - Math.round(years * 365.25 * 86_400);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${period1}&period2=${now}&interval=1mo&events=div`;
  const json = await plainFetch(url, { notFound: `No security found for "${symbol}".` });
  const result = json?.chart?.result?.[0];

  const stamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  // adjclose is adjusted for splits *and* dividends, so the pair of series is
  // exactly "with dividends reinvested" against "price only".
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose ?? [];

  const points = [];
  for (let i = 0; i < stamps.length; i++) {
    const close = num(closes[i]);
    if (close == null || close <= 0) continue;
    points.push({ t: stamps[i] * 1000, close, adjClose: num(adjusted[i]) ?? close });
  }

  return { dividends: parseDividends(result), points };
}

/**
 * Daily closes over an explicit window: the warehouse's incremental price
 * feed. The fixed `RANGES` are too coarse for this: asking for '1y' to pick up
 * three missing days refetches a year, and on a rate-limited API that is the
 * difference between a pipeline that runs nightly and one that gets blocked.
 */
export async function getDailyBars(symbol, sinceMs, untilMs = Date.now()) {
  const period1 = Math.floor(sinceMs / 1000);
  const period2 = Math.floor(untilMs / 1000) + 86_400;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${period1}&period2=${period2}&interval=1d`;
  const json = await plainFetch(url, { notFound: `No security found for "${symbol}".` });
  const result = json?.chart?.result?.[0];

  const stamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose ?? [];

  const bars = [];
  for (let i = 0; i < stamps.length; i++) {
    const close = num(quote.close?.[i]);
    if (close == null || close <= 0) continue;
    bars.push({
      t: stamps[i] * 1000,
      open: num(quote.open?.[i]),
      high: num(quote.high?.[i]),
      low: num(quote.low?.[i]),
      close,
      adjClose: num(adjusted[i]) ?? close,
      volume: num(quote.volume?.[i]) ?? 0,
    });
  }
  return bars;
}

/** Live quote fields for many symbols at once (session-gated). */
export async function getQuotes(symbols) {
  if (!symbols.length) return [];
  const list = symbols.map((s) => encodeURIComponent(s)).join(',');
  const json = await authFetch(
    (crumb) =>
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${list}&crumb=${encodeURIComponent(crumb)}`,
  );
  const rows = json?.quoteResponse?.result ?? [];
  return rows.map((q) => ({
    symbol: q.symbol,
    name: str(q.longName) ?? str(q.shortName) ?? q.symbol,
    currency: q.currency ?? 'USD',
    exchange: str(q.fullExchangeName) ?? str(q.exchange),
    quoteType: q.quoteType ?? 'EQUITY',
    marketState: q.marketState ?? null,
    price: num(q.regularMarketPrice),
    change: num(q.regularMarketChange),
    changePercent: num(q.regularMarketChangePercent),
    previousClose: num(q.regularMarketPreviousClose),
    dayHigh: num(q.regularMarketDayHigh),
    dayLow: num(q.regularMarketDayLow),
    fiftyTwoWeekHigh: num(q.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(q.fiftyTwoWeekLow),
    marketCap: num(q.marketCap),
    volume: num(q.regularMarketVolume),
    trailingPE: num(q.trailingPE),
    forwardPE: num(q.forwardPE),
    epsTrailingTwelveMonths: num(q.epsTrailingTwelveMonths),
    dividendYield: num(q.dividendYield),
    marketTime: num(q.regularMarketTime) ? num(q.regularMarketTime) * 1000 : null,
  }));
}

const SUMMARY_MODULES = [
  'price',
  'summaryDetail',
  'summaryProfile',
  'defaultKeyStatistics',
  'financialData',
  'calendarEvents',
  'recommendationTrend',
].join(',');

/** Fundamentals, valuation, analyst view and company profile (session-gated). */
export async function getSummary(symbol) {
  const json = await authFetch(
    (crumb) =>
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
      `?modules=${SUMMARY_MODULES}&crumb=${encodeURIComponent(crumb)}`,
  );
  const err = json?.quoteSummary?.error;
  if (err) throw new UpstreamError(err.description || `No profile for ${symbol}`, 404);
  return json?.quoteSummary?.result?.[0] ?? {};
}

const TIMESERIES_TYPES = [
  // Charted
  'TotalRevenue',
  'NetIncome',
  'DilutedEPS',
  'FreeCashFlow',
  'OperatingIncome',
  'GrossProfit',
  // Income statement, for the statement table.
  'CostOfRevenue',
  'ResearchAndDevelopment',
  'SellingGeneralAndAdministration',
  'OtherOperatingExpenses',
  'OperatingExpense',
  'TotalExpenses',
  'OtherNonOperatingIncomeExpenses',
  'InterestIncome',
  'NetInterestIncome',
  'PretaxIncome',
  'TaxProvision',
  'TaxRateForCalcs',
  'BasicEPS',
  'ReconciledDepreciation',
  // Scoring inputs. D&A and share count are what let us rebuild FFO for a
  // REIT, where net income is depressed by depreciation on assets that are
  // not actually losing value.
  'OperatingCashFlow',
  'CapitalExpenditure',
  'DepreciationAndAmortization',
  'EBITDA',
  'EBIT',
  'InterestExpense',
  'TotalDebt',
  'CashAndCashEquivalents',
  'StockholdersEquity',
  'TotalAssets',
  'CashDividendsPaid',
  'DilutedAverageShares',
];

const ACRONYM_KEYS = { EBITDA: 'ebitda', EBIT: 'ebit' };

/**
 * Reported financials by period.
 * @param {'annual'|'quarterly'} period
 */
export async function getFinancials(symbol, period = 'annual') {
  const prefix = period === 'quarterly' ? 'quarterly' : 'annual';
  const types = TIMESERIES_TYPES.map((t) => prefix + t).join(',');
  const now = Math.floor(Date.now() / 1000);
  const json = await authFetch(
    (crumb) =>
      `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
      `?symbol=${encodeURIComponent(symbol)}&type=${types}` +
      `&period1=493590046&period2=${now + 86400}&crumb=${encodeURIComponent(crumb)}`,
  );

  // Yahoo returns one entry per requested type; fold them into rows keyed by
  // period end date so the chart can plot aligned categories.
  const byDate = new Map();
  for (const entry of json?.timeseries?.result ?? []) {
    const type = entry?.meta?.type?.[0];
    if (!type) continue;
    const metric = type.replace(/^(annual|quarterly)/, '');
    // Lower-casing the first character alone mangles all-caps names:
    // "EBITDA" would become "eBITDA", so acronyms are mapped explicitly.
    const key = ACRONYM_KEYS[metric] ?? metric.charAt(0).toLowerCase() + metric.slice(1);
    for (const record of entry[type] ?? []) {
      if (!record?.asOfDate) continue;
      const row = byDate.get(record.asOfDate) ?? { date: record.asOfDate };
      row[key] = num(record.reportedValue);
      byDate.set(record.asOfDate, row);
    }
  }

  return [...byDate.values()]
    .filter((row) => row.totalRevenue != null || row.netIncome != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Symbol lookup for the search box (needs no session). */
export async function search(query) {
  const url =
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}` +
    `&quotesCount=8&newsCount=0&listsCount=0&enableFuzzyQuery=false`;
  const json = await plainFetch(url);
  return (json?.quotes ?? [])
    .filter((q) => q.symbol && q.isYahooFinance !== false)
    .map((q) => ({
      symbol: q.symbol,
      name: str(q.longname) ?? str(q.shortname) ?? q.symbol,
      exchange: str(q.exchDisp) ?? str(q.exchange),
      type: str(q.typeDisp) ?? str(q.quoteType),
      sector: str(q.sectorDisp),
    }));
}
