/**
 * Quality score as of each past reporting period, with the return over that
 * period beside it.
 *
 * These scores are **recomputed, not recorded**. There is one stored snapshot
 * of the live score, taken the first time the pipeline ran, so a real recorded
 * history does not exist yet and will not for years. What this does instead is
 * ask a different and still useful question: *given the numbers this company
 * reported for FY2023, how would it have graded?* The answer is computed from
 * today's stored statements, which means any restatement since is baked in, and
 * it is not what the screener would have printed at the time. The UI says so.
 *
 * Two things make the series internally consistent, which is what makes the
 * numbers comparable to each other:
 *
 * 1. **Every period, including the most recent, is scored the same way.** The
 *    live score on the card above uses Yahoo's own trailing P/E, dividend
 *    yield, five-year average yield and return on equity. None of those are
 *    available dated, so the series derives them from the statements and the
 *    price instead. Mixing the two would make the last point in the series
 *    incomparable with the rest of it, so the series computes its own latest
 *    point rather than borrowing the live one.
 *
 * 2. **Quarters are scored on trailing twelve months, not on the quarter.**
 *    The scorer reasons in years throughout: three-year average payout,
 *    five-year revenue CAGR, rolling dividend totals. Feeding it a single
 *    quarter would compare a quarter's revenue against a year's and call the
 *    result growth. So each quarter-end is scored on the four quarters ending
 *    there, and the growth comparison steps back four quarters at a time so a
 *    year-on-year rate really is year-on-year.
 *
 * The five-year average yield is the one input with no honest historical
 * reconstruction here, so it is left absent. The scorer already handles that:
 * below a 1% yield it falls back to a cash-flow yield anyway, and the pillar
 * renormalises over what it has and reports coverage.
 */

import { buildScore } from './score.js';

/* ------------------------------------------------------------------ helpers */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const ms = (isoDate) => Date.parse(`${isoDate}T00:00:00Z`);

/**
 * Flow items accumulate over a period; balance items are a snapshot at its end.
 * Summing a balance sheet over four quarters would report four times the debt.
 */
const FLOW_FIELDS = [
  'totalRevenue',
  'costOfRevenue',
  'grossProfit',
  'researchAndDevelopment',
  'operatingExpense',
  'operatingIncome',
  'interestExpense',
  'interestIncome',
  'pretaxIncome',
  'taxProvision',
  'netIncome',
  'dilutedEPS',
  'basicEPS',
  'depreciationAndAmortization',
  'reconciledDepreciation',
  'ebitda',
  'ebit',
  'operatingCashFlow',
  'capitalExpenditure',
  'freeCashFlow',
  'cashDividendsPaid',
];

const BALANCE_FIELDS = [
  'totalDebt',
  'cashAndCashEquivalents',
  'stockholdersEquity',
  'totalAssets',
  'dilutedAverageShares',
];

/**
 * Fold up to four consecutive quarters into one annual-equivalent row.
 *
 * With four quarters this is a true trailing twelve months. With fewer, flows
 * are averaged per quarter and multiplied back up to a year, because the
 * alternative is refusing to grade the period at all: Yahoo keeps about five
 * quarters, so the earliest quarter-ends never have four behind them and would
 * otherwise be permanently blank.
 *
 * The scaling is what makes a partial window usable and also what makes it
 * approximate. Annualising one quarter assumes the other three look like it,
 * which is wrong for any seasonal business: a retailer's December quarter
 * multiplied by four is a company that does not exist. The count of quarters
 * behind each row is returned so the caller can mark the thin ones rather than
 * present them as equivalent.
 *
 * Balance items are never scaled. They are a position at a moment, not a rate,
 * and multiplying debt by four would inflate every leverage ratio downstream.
 */
export function trailingTwelveMonths(quarters) {
  if (!quarters.length || quarters.length > 4) return null;

  const scale = 4 / quarters.length;
  const row = { date: quarters.at(-1).date, quartersUsed: quarters.length };

  for (const field of FLOW_FIELDS) {
    const values = quarters.map((q) => q[field]);
    // A field missing from any quarter in the window cannot be summed without
    // silently reporting a partial total as a whole one.
    row[field] = values.every(isNum) ? values.reduce((a, b) => a + b, 0) * scale : null;
  }
  for (const field of BALANCE_FIELDS) {
    const value = quarters.at(-1)[field];
    row[field] = isNum(value) ? value : null;
  }
  return row;
}

/** The last close at or before `date`. Null if the history starts after it. */
function closeAt(closes, date) {
  const target = ms(date);
  let best = null;
  for (const point of closes) {
    if (point.t > target) break;
    best = point;
  }
  return best;
}

/**
 * Total return between two dates, on dividend-adjusted closes.
 *
 * Adjusted rather than raw, because a year in which a company paid 6% and the
 * price went nowhere was not a flat year for anyone who held it.
 */
function returnBetween(closes, fromDate, toDate) {
  const start = closeAt(closes, fromDate);
  const end = closeAt(closes, toDate);
  if (!start || !end || start.t >= end.t) return null;
  const from = start.adjClose ?? start.close;
  const to = end.adjClose ?? end.close;
  if (!(from > 0) || !(to > 0)) return null;
  return (to / from - 1) * 100;
}

/** Trailing-twelve-month dividends per share as at `date`. */
function trailingYield(dividendPayments, date, price) {
  if (!(price > 0)) return null;
  const end = ms(date);
  const start = end - 365 * 86_400_000;
  const paid = dividendPayments
    .filter((p) => p.t > start && p.t <= end)
    .reduce((sum, p) => sum + (p.amount ?? 0), 0);
  return paid > 0 ? (paid / price) * 100 : null;
}

/**
 * The summary modules `buildScore` reads, rebuilt for a past date.
 *
 * Everything here is derived from that period's statements and that period's
 * price, so nothing from today leaks into a historical grade.
 */
function summaryAsAt(baseSummary, row, price) {
  const shares = row.dilutedAverageShares;
  const marketCap = isNum(shares) && isNum(price) ? shares * price : null;
  const eps = row.dilutedEPS;
  const equity = row.stockholdersEquity;

  return {
    // Sector and industry are properties of the company, not of the date, so
    // the REIT branch is decided the same way it is for the live score.
    summaryProfile: baseSummary.summaryProfile ?? {},
    price: {
      marketCap: marketCap == null ? null : { raw: marketCap },
      regularMarketPrice: price == null ? null : { raw: price },
    },
    summaryDetail: {
      // A negative or zero EPS has no meaningful P/E; left absent rather than
      // reported as a negative multiple.
      trailingPE: isNum(eps) && eps > 0 && isNum(price) ? { raw: price / eps } : null,
      marketCap: marketCap == null ? null : { raw: marketCap },
      // fiveYearAvgDividendYield is deliberately absent, see the module note.
    },
    defaultKeyStatistics: {},
    financialData: {
      currentPrice: price == null ? null : { raw: price },
      returnOnEquity: isNum(row.netIncome) && isNum(equity) && equity > 0 ? { raw: row.netIncome / equity } : null,
    },
  };
}

/* -------------------------------------------------------------------- build */

/**
 * @param {object} args
 * @param {object} args.summary           live quoteSummary, for industry only
 * @param {Array}  args.financials        statement rows, oldest first
 * @param {Array}  args.dividendPayments  [{ t, amount }]
 * @param {Array}  args.closes            [{ t, close, adjClose }], oldest first
 * @param {string} args.periodType        'annual' | 'quarterly'
 * @returns {{ periods, periodType, unscored, basis }}
 */
export function buildScoreHistory({
  summary = {},
  financials = [],
  dividendPayments = [],
  closes = [],
  periodType = 'annual',
} = {}) {
  const quarterly = periodType === 'quarterly';
  const rows = financials.filter((r) => r?.date).sort((a, b) => a.date.localeCompare(b.date));
  const sortedCloses = [...closes].sort((a, b) => a.t - b.t);
  const payments = [...dividendPayments].sort((a, b) => a.t - b.t);

  const periods = [];
  const unscored = [];

  // Each entry becomes one row of the table: the period, the score as at its
  // end, and the return earned over it.
  for (let i = 0; i < rows.length; i++) {
    const end = rows[i].date;

    // The series the scorer sees. Annual: every year up to this one. Quarterly:
    // trailing-twelve-month rows stepping back a year at a time, so a
    // year-on-year growth rate really spans a year.
    let series;
    if (quarterly) {
      series = [];
      // Step back a year at a time so a year-on-year growth rate really spans a
      // year. The earliest window is whatever is left, annualised from it.
      for (let j = i; j >= 0; j -= 4) series.unshift(trailingTwelveMonths(rows.slice(Math.max(0, j - 3), j + 1)));
      series = series.filter(Boolean);
    } else {
      series = rows.slice(0, i + 1);
    }

    if (!series.length) {
      unscored.push({ period: end, reason: quarterly ? 'fewer than four quarters reported' : 'no statements' });
      continue;
    }

    const point = closeAt(sortedCloses, end);
    if (!point) {
      unscored.push({ period: end, reason: 'no price history at this date' });
      continue;
    }
    const price = point.close;

    const asAt = summaryAsAt(summary, series.at(-1), price);
    const yieldPct = trailingYield(payments, end, price);
    if (yieldPct != null) asAt.summaryDetail.dividendYield = { raw: yieldPct / 100 };

    const score = buildScore({
      summary: asAt,
      financials: series,
      dividendPayments: payments.filter((p) => p.t <= ms(end)),
    });

    if (score?.overall == null) {
      unscored.push({ period: end, reason: 'not enough reported data to grade' });
      continue;
    }

    // The window the return is measured over is the reporting period itself,
    // so the number beside a score is the return earned across exactly the
    // stretch those statements describe.
    const previous = rows[i - 1]?.date ?? null;
    const windowStart = previous ?? shiftBack(end, quarterly ? 3 : 12);

    periods.push({
      period: end,
      label: periodLabel(end, quarterly),
      // How many reporting periods fed this grade. The earliest point in a
      // series has the least behind it: AAPL's FY2022 grades A+ partly because
      // with one year of statements there is no revenue or EPS trend to score,
      // so its growth pillar rests on the dividend record alone and
      // renormalises to a fuller weight than it has earned. Surfaced so the
      // reader can discount the early points rather than read a decline that
      // is really a change in how much was known.
      statementPeriods: series.length,
      // For a quarter, how many quarters were actually behind the row it was
      // graded on. Four is a true trailing year; fewer has been scaled up and
      // carries whatever seasonality the missing quarters would have offset.
      quartersUsed: quarterly ? (series.at(-1)?.quartersUsed ?? null) : null,
      score: score.overall,
      grade: score.grade,
      coverage: score.coverage ?? null,
      basis: score.basis ?? null,
      price,
      totalReturn: returnBetween(sortedCloses, windowStart, end),
      windowStart,
      // Pillar detail, so the table can show what moved a grade rather than
      // only that it moved.
      pillars: (score.pillars ?? []).map((p) => ({ title: p.title, score: p.score })),
    });
  }

  periods.reverse(); // most recent first, the way the table reads

  return {
    periods,
    periodType,
    unscored,
    basis: periods[0]?.basis ?? null,
  };
}

/** `2025-09-30` shifted back n months, clamped to the end of the month. */
function shiftBack(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  // Clamp: stepping back from the 31st into a 30-day month must not roll over.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** `2025-09-30` -> `FY2025`, or `Q3 2025` for a quarter. */
export function periodLabel(isoDate, quarterly) {
  const [year, month] = isoDate.split('-').map(Number);
  if (!quarterly) return `FY${year}`;
  return `Q${Math.ceil(month / 3)} ${year}`;
}
