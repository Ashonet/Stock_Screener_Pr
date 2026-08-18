/**
 * Turns Yahoo's module soup into the flat, typed metric bundle the dashboard
 * renders. Every value is a plain number (or null) plus a declared `kind`, so
 * the frontend formats by kind and never has to know where a number came from.
 *
 * `kind` is one of: currency | number | percent | ratio | integer | date | text
 */

import { num } from './yahoo.js';
import { isREIT } from './score.js';

const pick = (...values) => values.find((v) => v != null) ?? null;

/** Yahoo reports fractions (0.276) for margins but plain percents elsewhere. */
const asPercent = (fraction) => (fraction == null ? null : fraction * 100);

const epochToISO = (v) => {
  const seconds = num(v);
  if (!seconds) return null;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

function metric(label, value, kind, hint) {
  return { label, value, kind, hint: hint ?? null };
}

/**
 * A *yesterday* close from the price chart, or nothing.
 *
 * This is the fallback used when the session-gated summary is unavailable, and
 * it has to be range-aware. Yahoo's `chartPreviousClose` is the close before the
 * first bar of the requested window, on a 1-day chart that is yesterday, but on
 * the MAX chart it is the price before the company's first monthly bar. Using it
 * blindly priced NVIDIA's previous close at $0.0440 and reported the day's move
 * as +511,286%.
 *
 * So: trust it only on the intraday range, otherwise take the second-to-last
 * bar and only when the bars are daily. On weekly or monthly granularity there
 * is no honest day-over-day close available, and returning null (which the UI
 * renders as "n/a") beats inventing one.
 */
function chartPreviousClose(chart) {
  if (!chart) return null;
  if (chart.range === '1d') return chart.previousClose ?? null;

  const daily = chart.interval === '1d';
  const points = chart.points ?? [];
  if (daily && points.length >= 2) return points.at(-2).c ?? null;

  return null;
}

export function buildProfile(symbol, summary, chart) {
  const price = summary.price ?? {};
  const detail = summary.summaryDetail ?? {};
  const stats = summary.defaultKeyStatistics ?? {};
  const financial = summary.financialData ?? {};
  const company = summary.summaryProfile ?? {};
  const calendar = summary.calendarEvents ?? {};

  const last = pick(num(price.regularMarketPrice), chart?.price);
  const prevClose = pick(num(price.regularMarketPreviousClose), num(detail.previousClose), chartPreviousClose(chart));
  const change = pick(num(price.regularMarketChange), last != null && prevClose != null ? last - prevClose : null);
  const changePercent = pick(
    num(price.regularMarketChangePercent) != null ? num(price.regularMarketChangePercent) * 100 : null,
    change != null && prevClose ? (change / prevClose) * 100 : null,
  );

  const quote = {
    symbol: price.symbol ?? chart?.symbol ?? symbol.toUpperCase(),
    name: pick(price.longName, price.shortName, chart?.name, symbol.toUpperCase()),
    currency: pick(price.currency, chart?.currency, 'USD'),
    exchange: pick(price.exchangeName, chart?.exchange),
    quoteType: pick(price.quoteType, chart?.instrumentType, 'EQUITY'),
    marketState: price.marketState ?? null,
    sector: company.sector ?? null,
    industry: company.industry ?? null,
    website: company.website ?? null,
    country: company.country ?? null,
    employees: num(company.fullTimeEmployees),
    description: company.longBusinessSummary ?? null,
    price: last,
    previousClose: prevClose,
    change,
    changePercent,
    open: num(detail.open),
    dayLow: pick(num(detail.dayLow), chart?.dayLow),
    dayHigh: pick(num(detail.dayHigh), chart?.dayHigh),
    volume: pick(num(detail.volume), chart?.volume),
    averageVolume: num(detail.averageVolume),
    fiftyTwoWeekLow: pick(num(detail.fiftyTwoWeekLow), chart?.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: pick(num(detail.fiftyTwoWeekHigh), chart?.fiftyTwoWeekHigh),
    marketTime: pick(num(price.regularMarketTime) ? num(price.regularMarketTime) * 1000 : null, chart?.marketTime),
  };

  const marketCap = pick(num(price.marketCap), num(detail.marketCap));
  const enterpriseValue = num(stats.enterpriseValue);
  const ebitda = num(financial.ebitda);

  // Earnings-based ratios are not wrong for a REIT so much as not comparable:
  // depreciation on property that is holding its value pushes reported earnings
  // far below the cash produced, so P/E reads double what P/FFO does. Flag them
  // where they appear rather than quietly showing a number that invites a bad
  // like-for-like comparison.
  const reit = isREIT(company);
  const earningsCaveat = reit
    ? 'Not comparable across property types: a REIT’s reported earnings are depressed by depreciation. See P/FFO in the quality score.'
    : null;

  const groups = [
    {
      title: 'Valuation',
      metrics: [
        metric('Market cap', marketCap, 'currency'),
        metric('Enterprise value', enterpriseValue, 'currency'),
        metric('P/E (TTM)', pick(num(detail.trailingPE), num(stats.trailingPE)), 'ratio', earningsCaveat),
        metric('Forward P/E', num(detail.forwardPE), 'ratio', earningsCaveat),
        metric('PEG ratio', num(stats.pegRatio), 'ratio', earningsCaveat ?? 'P/E divided by expected growth'),
        metric('Price / sales', num(stats.priceToSalesTrailing12Months) ?? num(detail.priceToSalesTrailing12Months), 'ratio'),
        metric('Price / book', num(stats.priceToBook), 'ratio'),
        metric('EV / EBITDA', enterpriseValue != null && ebitda ? enterpriseValue / ebitda : null, 'ratio'),
      ],
    },
    {
      title: 'Profitability',
      metrics: [
        metric('Gross margin', asPercent(num(financial.grossMargins)), 'percent'),
        metric('Operating margin', asPercent(num(financial.operatingMargins)), 'percent'),
        metric('Profit margin', asPercent(num(financial.profitMargins) ?? num(stats.profitMargins)), 'percent'),
        metric('Return on equity', asPercent(num(financial.returnOnEquity)), 'percent'),
        metric('Return on assets', asPercent(num(financial.returnOnAssets)), 'percent'),
        metric('Revenue (TTM)', num(financial.totalRevenue), 'currency'),
        metric('Free cash flow', num(financial.freeCashflow), 'currency'),
        metric('EPS (TTM)', num(stats.trailingEps), 'currency'),
      ],
    },
    {
      title: 'Growth',
      metrics: [
        metric('Revenue growth (YoY)', asPercent(num(financial.revenueGrowth)), 'percent'),
        metric('Earnings growth (YoY)', asPercent(num(financial.earningsGrowth)), 'percent'),
        metric('Quarterly earnings growth', asPercent(num(stats.earningsQuarterlyGrowth)), 'percent'),
        metric('52-week change', asPercent(num(stats['52WeekChange'])), 'percent'),
      ],
    },
    {
      title: 'Dividend',
      metrics: [
        metric('Dividend yield', asPercent(num(detail.dividendYield)), 'percent'),
        metric('Annual dividend', num(detail.dividendRate), 'currency'),
        metric(
          'Payout ratio',
          asPercent(num(detail.payoutRatio)),
          'percent',
          reit
            ? 'Share of earnings paid out, routinely over 100% for a REIT, and not a warning on its own. The cash-flow payout in the quality score is the meaningful one.'
            : 'Share of earnings paid out',
        ),
        metric('5-year average yield', num(detail.fiveYearAvgDividendYield), 'percent'),
        metric('Ex-dividend date', epochToISO(detail.exDividendDate ?? calendar.exDividendDate), 'date'),
        metric('Next dividend date', epochToISO(calendar.dividendDate), 'date'),
      ],
    },
    {
      title: 'Balance sheet',
      metrics: [
        metric('Total cash', num(financial.totalCash), 'currency'),
        metric('Total debt', num(financial.totalDebt), 'currency'),
        metric('Debt / equity', num(financial.debtToEquity), 'ratio'),
        metric('Current ratio', num(financial.currentRatio), 'ratio'),
        metric('Book value / share', num(stats.bookValue), 'currency'),
        metric('Shares outstanding', num(stats.sharesOutstanding), 'integer'),
      ],
    },
    {
      title: 'Trading',
      metrics: [
        metric('Beta (5Y monthly)', num(stats.beta) ?? num(detail.beta), 'ratio'),
        metric('Volume', num(detail.volume), 'integer'),
        metric('Average volume', num(detail.averageVolume), 'integer'),
        metric('50-day average', num(detail.fiftyDayAverage), 'currency'),
        metric('200-day average', num(detail.twoHundredDayAverage), 'currency'),
        metric('Short % of float', asPercent(num(stats.shortPercentOfFloat)), 'percent'),
      ],
    },
  ];

  // A group with nothing in it (ETFs have no balance sheet, non-payers no
  // dividend) is dropped rather than rendered as a wall of dashes.
  const populated = groups
    .map((g) => ({ ...g, metrics: g.metrics.filter((m) => m.value != null) }))
    .filter((g) => g.metrics.length > 0)
    // A non-payer sometimes keeps a stale ex-dividend date on file. Without a
    // yield or a rate there is no dividend to report, so drop the section
    // rather than headline a lone leftover date.
    .filter((g) => g.title !== 'Dividend' || g.metrics.some((m) => m.label === 'Dividend yield' || m.label === 'Annual dividend'));

  const targets = {
    low: num(financial.targetLowPrice),
    mean: num(financial.targetMeanPrice),
    high: num(financial.targetHighPrice),
    median: num(financial.targetMedianPrice),
    analysts: num(financial.numberOfAnalystOpinions),
    recommendation: financial.recommendationKey ?? null,
    score: num(financial.recommendationMean),
  };

  const trendRow = (summary.recommendationTrend?.trend ?? []).find((t) => t.period === '0m');
  const consensus = trendRow
    ? {
        strongBuy: num(trendRow.strongBuy) ?? 0,
        buy: num(trendRow.buy) ?? 0,
        hold: num(trendRow.hold) ?? 0,
        sell: num(trendRow.sell) ?? 0,
        strongSell: num(trendRow.strongSell) ?? 0,
      }
    : null;

  return { quote, groups: populated, targets, consensus };
}

/** Sum dividends per calendar year, most recent last. Drops the partial year. */
export function dividendsByYear(dividends, { years = 12 } = {}) {
  const totals = new Map();
  for (const d of dividends) {
    const year = new Date(d.t).getUTCFullYear();
    totals.set(year, (totals.get(year) ?? 0) + d.amount);
  }
  const rows = [...totals.entries()]
    .map(([year, amount]) => ({ year, amount: Number(amount.toFixed(4)) }))
    .sort((a, b) => a.year - b.year);

  // The current year is still accruing payments, so charting it beside
  // completed years would read as a cut. Flag it; the frontend labels it.
  const thisYear = new Date().getUTCFullYear();
  for (const row of rows) row.partial = row.year === thisYear;

  return rows.slice(-years);
}
