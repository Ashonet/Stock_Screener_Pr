/**
 * Where the constituent lists come from.
 *
 * Each index is fetched rather than typed, for the reason `build-universe.js`
 * gives at length: membership changes constantly and a hand-written list rots
 * silently into missing additions and dead tickers.
 *
 * The three differ in what they even mean, which matters downstream:
 *
 *   sp500        a curated index with a published constituent file
 *   nasdaq       every common stock *listed on* an exchange, not an index at
 *                all, so it carries the whole long tail including companies
 *                with no analyst coverage and a few million dollars of volume
 *   russell2000  a small-cap index whose official list is proprietary, so it
 *                is read from a tracking fund's disclosed holdings instead,
 *                which is a good approximation and not the index itself
 */

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; stock-warehouse/1.0)' };

/** Yahoo writes share-class separators as a hyphen: BRK.B is BRK-B. */
export const toYahoo = (ticker) => String(ticker).trim().toUpperCase().replace(/\./g, '-');

/** A plausible US common-stock ticker, before Yahoo is asked about it. */
const PLAUSIBLE = /^[A-Z]{1,5}(-[A-Z])?$/;

async function getText(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

/* --------------------------------------------------------------------- S&P */

const SP500_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

/** Minimal CSV field split that respects quoted commas. */
function firstField(line) {
  if (line.startsWith('"')) return line.slice(1, line.indexOf('"', 1));
  return line.slice(0, line.indexOf(','));
}

async function fetchSp500() {
  const text = await getText(SP500_URL);
  const symbols = new Set();
  for (const row of text.trim().split(/\r?\n/).slice(1)) {
    const raw = firstField(row);
    if (/^[A-Z][A-Z.\-]{0,9}$/i.test(raw)) symbols.add(toYahoo(raw));
  }
  return { symbols: [...symbols], source: SP500_URL };
}

/* ------------------------------------------------------------------ Nasdaq */

const NASDAQ_URL = 'https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt';

/**
 * Every Nasdaq-listed common stock.
 *
 * The file is pipe-delimited with a trailing "File Creation Time" line that is
 * not a record. ETFs and test issues are dropped by their own columns: an ETF
 * has no financial statements to score and a test issue is not a company.
 *
 * A quarter of what is left is still not a company. The listing carries 377
 * warrants, 284 preferreds, 259 units, 103 rights and 56 notes, and their
 * tickers look exactly like ordinary ones: AACIU is a SPAC unit, AACIW its
 * warrant, AACPR a preferred. Nothing in the file marks them except the
 * security name, so that is what is read. Left in, they are 1,079 symbols with
 * no statements to score, filling a screener with instruments nobody screens.
 */
/**
 * Whether a security name describes something other than common stock.
 *
 * Three separate traps sit in what looks like a one-line regex.
 *
 * The **word boundaries** are load-bearing. Without them "unit" matches inside
 * United and Communities, and "note" inside Noteworthy.
 *
 * **"Depositary" is deliberately absent.** An ADR is a real company's equity
 * with real statements behind it, and matching the word would drop PDD, Baidu,
 * JD and NetEase along with 181 others. The depositary issues actually worth
 * excluding are preferreds wrapped in a receipt, and they say so in full:
 * "Depositary Shares, each representing ... Series A Preferred Stock" is
 * already caught by `preferred`.
 *
 * **Only the security type is tested, not the company name.** The file writes
 * each row as "Company Name - Security Type", and a company is free to have one
 * of these words in its name: Preferred Bank is an ordinary Nasdaq-listed bank
 * whose common stock reads "Preferred Bank - Common Stock". Matching the whole
 * string deletes it. Matching only what follows the separator does not.
 */
const NOT_COMMON_STOCK = /\b(?:warrants?|units?|rights?|preferred|notes?|debenture)\b/i;

function isCommonStock(securityName) {
  const name = String(securityName ?? '');
  const separator = name.indexOf(' - ');
  // No separator means the row does not declare a type; judge the whole string
  // rather than assume, since an undeclared warrant is worse than a lost row.
  const type = separator === -1 ? name : name.slice(separator + 3);
  return !NOT_COMMON_STOCK.test(type);
}
async function fetchNasdaq() {
  const text = await getText(NASDAQ_URL);
  const lines = text.trim().split(/\r?\n/).filter((line) => line && !line.startsWith('File Creation'));
  const header = lines[0].split('|');
  const index = (name) => header.indexOf(name);

  const symbols = new Set();
  for (const line of lines.slice(1)) {
    const cells = line.split('|');
    if (cells[index('ETF')] === 'Y') continue;
    if (cells[index('Test Issue')] === 'Y') continue;
    if (!isCommonStock(cells[index('Security Name')])) continue;
    const ticker = toYahoo(cells[index('Symbol')]);
    if (PLAUSIBLE.test(ticker)) symbols.add(ticker);
  }
  return { symbols: [...symbols], source: NASDAQ_URL };
}

/* ------------------------------------------------------------ Russell 2000 */

const RUSSELL_BASE = 'https://investor.vanguard.com/investment-products/etfs/profile/api/vtwo/portfolio-holding/stock';

/**
 * Russell 2000 constituents, by way of a fund that tracks it.
 *
 * FTSE Russell does not publish the constituent list freely, so this reads
 * Vanguard's disclosed holdings for VTWO. That is an approximation and worth
 * naming as one: a tracking fund holds what it holds on its disclosure date,
 * which lags the index reconstitution and can miss the smallest weights
 * entirely. It is close enough to be useful and is not the index.
 *
 * The endpoint pages five hundred at a time.
 */
async function fetchRussell2000() {
  const symbols = new Set();
  let start = 1;

  for (let page = 0; page < 12; page++) {
    const res = await fetch(`${RUSSELL_BASE}?start=${start}&count=500`, {
      headers: { ...UA, accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Russell source returned ${res.status}`);
    const json = await res.json();
    const entities = json?.fund?.entity ?? [];
    if (!entities.length) break;

    for (const holding of entities) {
      const ticker = toYahoo(holding?.ticker ?? '');
      if (PLAUSIBLE.test(ticker)) symbols.add(ticker);
    }
    // Cash lines and the fund's own hedges have no ticker, so a short page is
    // not necessarily the last one; stop on the declared total instead.
    start += 500;
    if (json?.size && start > json.size) break;
  }

  if (!symbols.size) throw new Error('Russell source returned no parseable tickers');
  return { symbols: [...symbols], source: RUSSELL_BASE };
}

/* ------------------------------------------------------------------ export */

export const INDEXES = {
  sp500: { label: 'S&P 500', fetch: fetchSp500 },
  nasdaq: { label: 'Nasdaq listed', fetch: fetchNasdaq },
  russell2000: { label: 'Russell 2000', fetch: fetchRussell2000 },
};

export const INDEX_NAMES = Object.keys(INDEXES);
