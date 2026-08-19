/**
 * A wallet's quality score over time, weighted by what it actually held.
 *
 * Three things move this line, and separating them is the whole point:
 *
 *   1. A company's own grade changes when it reports.
 *   2. A holding's weight changes as its price moves relative to the others.
 *   3. A holding joins the wallet when it is bought, and before that date it
 *      does not count at all.
 *
 * The third is what makes this a portfolio's score rather than a watchlist's
 * average. A wallet that held one C-graded company for a year and then bought
 * three A-graded ones did not have a good portfolio for that year, and a line
 * that back-applied today's holdings would say it did.
 *
 * **Weighted by position value, not by holding count.** An equal-weight average
 * lets a 200 dollar position outvote a 60,000 dollar one, which is the opposite
 * of what a portfolio's quality means: the score is what your money is invested
 * in, so the money does the weighting.
 *
 * A holding with no grade, anything outside the scored universe, is left out of
 * the score itself rather than counted as zero. Counting it as zero would
 * report a portfolio of good companies plus one unrated one as mediocre, which
 * is a statement about our coverage rather than about the portfolio.
 *
 * It does still count toward `coverage`, which is the share of the wallet's
 * value that carried a grade. That number is the reason the omission is safe to
 * make: a score resting on a third of the portfolio is a different claim from
 * one resting on all of it, and the reader is told which they have.
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const ms = (isoDate) => Date.parse(`${isoDate}T00:00:00Z`);

/** The last close at or before `t`, walking a cursor rather than re-scanning. */
function priceAt(points, t, cursor) {
  while (cursor.i < points.length && points[cursor.i].t <= t) {
    cursor.last = points[cursor.i];
    cursor.i++;
  }
  return cursor.last?.close ?? null;
}

/** The grade in force at `t`: the last reporting period that had closed by then. */
function scoreAt(periods, t) {
  let chosen = null;
  for (const period of periods) {
    if (ms(period.period) > t) break;
    if (isNum(period.score)) chosen = period;
  }
  return chosen;
}

/**
 * @param {object} args
 * @param {Array} args.holdings   [{ symbol, shares, boughtAt }]
 * @param {Map}   args.timelines  symbol -> [{ period, score, grade }] oldest first
 * @param {Map}   args.prices     symbol -> [{ t, close }] oldest first
 * @returns {{ points, current, holdings, excluded, startedAt }}
 */
export function buildPortfolioScoreHistory({ holdings = [], timelines = new Map(), prices = new Map() } = {}) {
  const tracked = holdings
    .map((holding) => ({
      holding,
      periods: timelines.get(holding.symbol) ?? null,
      points: prices.get(holding.symbol) ?? null,
      heldFrom: holding.boughtAt ? ms(holding.boughtAt) : -Infinity,
    }))
    .filter((entry) => entry.points?.length);

  const excluded = holdings
    .filter((holding) => {
      const entry = tracked.find((e) => e.holding.symbol === holding.symbol);
      return !entry || !entry.periods?.length;
    })
    .map((holding) => ({
      symbol: holding.symbol,
      reason: prices.has(holding.symbol) ? 'not scored' : 'no price history',
    }));

  // Coverage is the share of the wallet's value that carried a grade, so the
  // denominator has to include holdings that are priced and ungraded. Walking
  // only the graded ones would report 100% coverage on a wallet that is half
  // unrated, which is precisely the case the number exists to reveal.
  if (!tracked.some((entry) => entry.periods?.length)) {
    return { points: [], current: null, holdings: [], excluded, startedAt: null };
  }

  // A month is the right grain: a grade only moves when a company reports, so a
  // daily line would be a step function sampled two hundred times per step.
  const times = [...new Set(tracked.flatMap((entry) => entry.points.map((point) => point.t)))].sort((a, b) => a - b);

  const cursors = new Map(tracked.map((entry) => [entry.holding.symbol, { i: 0, last: null }]));
  const points = [];

  for (const t of times) {
    let weighted = 0;
    let gradedValue = 0;
    let heldValue = 0;

    for (const entry of tracked) {
      const price = priceAt(entry.points, t, cursors.get(entry.holding.symbol));
      if (t < entry.heldFrom || price == null) continue;

      const value = price * entry.holding.shares;
      heldValue += value;

      const period = entry.periods?.length ? scoreAt(entry.periods, t) : null;
      if (!period) continue;
      gradedValue += value;
      weighted += period.score * value;
    }

    if (gradedValue <= 0) continue;
    points.push({
      t,
      c: weighted / gradedValue,
      // What share of the wallet's value carried a grade at this point. A line
      // resting on a third of the portfolio is not the same statement as one
      // resting on all of it.
      coverage: heldValue > 0 ? (gradedValue / heldValue) * 100 : null,
    });
  }

  /* ------------------------------------------------------------- current */

  const latest = times.at(-1);
  const composition = [];
  let currentWeighted = 0;
  let currentGraded = 0;
  let currentHeld = 0;

  for (const entry of tracked) {
    const point = entry.points.at(-1);
    const price = point?.close ?? null;
    if (price == null || latest < entry.heldFrom) continue;

    const value = price * entry.holding.shares;
    currentHeld += value;
    const period = entry.periods?.length ? scoreAt(entry.periods, latest) : null;
    if (period) {
      currentGraded += value;
      currentWeighted += period.score * value;
      composition.push({
        symbol: entry.holding.symbol,
        value,
        score: period.score,
        grade: period.grade,
        asOf: period.period,
      });
    }
  }

  for (const row of composition) row.weight = currentGraded > 0 ? (row.value / currentGraded) * 100 : null;
  composition.sort((a, b) => b.value - a.value);

  return {
    points,
    startedAt: points[0]?.t ?? null,
    current:
      currentGraded > 0
        ? {
            score: currentWeighted / currentGraded,
            coverage: currentHeld > 0 ? (currentGraded / currentHeld) * 100 : null,
            gradedHoldings: composition.length,
          }
        : null,
    holdings: composition,
    excluded,
  };
}
