/**
 * Equal-weight portfolios by quality grade, and how they actually did.
 *
 * The question: split the same amount of money evenly across every company
 * holding a given grade, hold it, and see where each grade's portfolio ends up.
 * If the scorer is worth anything, A should beat F.
 *
 * **The grade used to form the portfolio is the whole methodology.** Two
 * different questions hide behind the same table:
 *
 *   `then` - the grade the company held on the day the window opened. This is a
 *            strategy: you could have run it, because the grade was knowable at
 *            the time. It needs a reporting period to have closed before the
 *            window starts, so it only reaches back as far as the statements do.
 *
 *   `now`  - today's grade, applied backwards. This is **not** a strategy and
 *            cannot be run. It asks "how have the companies that are good today
 *            performed", which flatters the good grades by construction: a
 *            company earns an A partly by having done well over the very period
 *            being measured. It is offered because it reaches back further, and
 *            labelled because the difference between the two is the difference
 *            between a backtest and a rationalisation.
 *
 * Equal weight, bought once, never rebalanced. So a grade's return is the plain
 * mean of its members' returns, which is what putting the same amount into each
 * and leaving it produces. Rebalancing would be a different strategy with its
 * own trading costs, and pretending it is free is a standard way to manufacture
 * outperformance that does not survive contact with a broker.
 *
 * Survivorship is the honest weakness. The universe is today's index, so
 * companies that were dropped are absent, and removals skew toward failures.
 * Every grade is flattered by that, the low grades most of all, since those are
 * the ones the departed would have joined.
 */

const GRADE_ORDER = ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D', 'F'];

/** Median of a numeric array, which is not in the standard library. */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One window's result: every grade's equal-weight portfolio return.
 *
 * @param {Array} returns  [{ symbol, totalReturn }] over the window
 * @param {Map}   grades   symbol -> grade in force for this window
 * @param {number} years   the window's length, for annualising
 */
export function gradePortfolios(returns, grades, years) {
  const buckets = new Map();

  for (const row of returns) {
    const grade = grades.get(row.symbol);
    if (!grade || !Number.isFinite(row.totalReturn)) continue;
    if (!buckets.has(grade)) buckets.set(grade, []);
    buckets.get(grade).push(row);
  }

  const rows = [];
  for (const grade of GRADE_ORDER) {
    const members = buckets.get(grade);
    if (!members?.length) continue;

    const values = members.map((m) => m.totalReturn);
    // Equal money in each, held. The portfolio's return is then the mean of the
    // members', with no rebalancing assumed and none charged for.
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const best = members.reduce((a, b) => (b.totalReturn > a.totalReturn ? b : a));
    const worst = members.reduce((a, b) => (b.totalReturn < a.totalReturn ? b : a));

    rows.push({
      grade,
      count: members.length,
      totalReturn: mean,
      medianReturn: median(values),
      annualisedReturn: years >= 1 ? ((1 + mean / 100) ** (1 / years) - 1) * 100 : null,
      best: { symbol: best.symbol, totalReturn: best.totalReturn },
      worst: { symbol: worst.symbol, totalReturn: worst.totalReturn },
      // How many of this grade's members beat the whole universe's average.
      // A grade can post a good mean off one holding, and this says whether it
      // did.
      positive: values.filter((v) => v > 0).length,
      // Everything in the bucket, best first. The summary rows describe a
      // portfolio and this is what was in it, which is the difference between
      // a number to read and a number to check.
      members: members
        .map((member) => ({ symbol: member.symbol, totalReturn: member.totalReturn }))
        .sort((a, b) => b.totalReturn - a.totalReturn),
    });
  }

  const all = returns.filter((r) => Number.isFinite(r.totalReturn)).map((r) => r.totalReturn);
  const universeMean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : null;

  // Does the ladder hold? The single number worth reading off the whole table:
  // the top grade's return less the bottom's. Positive means the ordering
  // worked over this window, and one window is not evidence of much.
  const graded = rows.filter((r) => r.count > 0);
  const spread = graded.length >= 2 ? graded[0].totalReturn - graded.at(-1).totalReturn : null;

  return {
    rows,
    universeMean,
    universeCount: all.length,
    spread,
    topGrade: graded[0]?.grade ?? null,
    bottomGrade: graded.at(-1)?.grade ?? null,
  };
}

/**
 * The grade each symbol held on `asOf`, from its recomputed grade timeline.
 *
 * The most recent period that had *closed* by then, so nothing is assigned on
 * the strength of statements published after the date it is being applied to.
 */
export function gradesAsOf(timelines, asOf) {
  const out = new Map();
  for (const [symbol, periods] of timelines) {
    let chosen = null;
    for (const period of periods) {
      if (period.period <= asOf && period.grade) chosen = period;
    }
    if (chosen) out.set(symbol, chosen.grade);
  }
  return out;
}

export { GRADE_ORDER };
