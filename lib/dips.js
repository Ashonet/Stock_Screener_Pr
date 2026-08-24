/**
 * Which holdings are trading well below their own recent range.
 *
 * Two independent readings of "cheaper than usual", because one on its own is
 * easy to misread:
 *
 *   **Off the high.** Where the price sits in its own 52-week range. Purely
 *   mechanical, no opinion in it, and no information about whether the fall was
 *   deserved.
 *
 *   **Yield against its own history.** For a dividend payer, price and yield
 *   move opposite ways, so a yield above its own five-year average is the same
 *   fact from the income side. It is the more useful of the two when it works,
 *   and it stops working on a token dividend: at a 0.02% yield the ratio is
 *   noise, which is how NVIDIA once read 8.8 times its own average purely
 *   because both numbers round to nothing. Below a 1% yield it is withheld.
 *
 * **A dip is not an opportunity, and this cannot tell you which it is.** A
 * company 40% off its high may be 40% worse than it was. That is exactly why
 * the quality grade travels with every row: the question worth asking is
 * whether anything about the business changed, and a screen for cheapness
 * cannot answer it. What it can do is tell you where to look.
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Below this the yield-against-history ratio is noise rather than signal. */
const MEANINGFUL_YIELD = 1;

/**
 * @param {Array} holdings  [{ symbol, shares, cost }]
 * @param {Map}   ranges    symbol -> { price, high, low, from, asOf }
 * @param {Map}   facts     symbol -> { name, grade, score, yieldPct, avgYieldPct }
 * @returns {{ rows, excluded, window }}
 */
export function findDips(holdings = [], ranges = new Map(), facts = new Map(), { windowDays = 365 } = {}) {
  const rows = [];
  const excluded = [];

  for (const holding of holdings) {
    const range = ranges.get(holding.symbol);
    if (!range || !(range.price > 0) || !(range.high > 0)) {
      excluded.push({ symbol: holding.symbol, reason: 'no price history' });
      continue;
    }

    const fact = facts.get(holding.symbol) ?? {};
    const { price, high, low } = range;

    // Where in the band, 0 at the low and 100 at the high. Withheld when the
    // band has no width, which happens to a symbol listed inside the window.
    const span = isNum(low) && high > low ? high - low : null;
    const rangePosition = span ? ((price - low) / span) * 100 : null;

    const yieldPct = isNum(fact.yieldPct) ? fact.yieldPct : null;
    const avgYieldPct = isNum(fact.avgYieldPct) ? fact.avgYieldPct : null;
    const yieldUsable = yieldPct != null && yieldPct >= MEANINGFUL_YIELD && avgYieldPct > 0;

    rows.push({
      symbol: holding.symbol,
      name: fact.name ?? null,
      grade: fact.grade ?? null,
      score: isNum(fact.score) ? fact.score : null,
      price,
      high,
      low: isNum(low) ? low : null,
      asOf: range.asOf ?? null,
      // Negative: how far under the high it is trading.
      offHigh: (price / high - 1) * 100,
      offLow: isNum(low) && low > 0 ? (price / low - 1) * 100 : null,
      rangePosition,
      yieldPct,
      avgYieldPct,
      // Above 1 means it yields more than it usually has, which is the income
      // side of the same fall. Null where the yield is too small to mean it.
      yieldVsAverage: yieldUsable ? yieldPct / avgYieldPct : null,
      // The personal version: against what this holding cost, not against the
      // market's own high. A position can be well off its high and still up on
      // cost, which is a different thing to feel about it.
      vsCost: isNum(holding.cost) && holding.cost > 0 ? (price / holding.cost - 1) * 100 : null,
    });
  }

  // Deepest fall first, because that is the question being asked. Quality is
  // reported per row rather than mixed into the ordering: blending "cheap" and
  // "good" into one number hides which of the two produced the rank.
  rows.sort((a, b) => a.offHigh - b.offHigh);

  return {
    rows,
    excluded,
    windowDays,
    // A count worth having on the card: how many are meaningfully off, rather
    // than merely not at a high. Ten percent is a convention, not a threshold
    // with any predictive claim behind it.
    dipping: rows.filter((row) => row.offHigh <= -10).length,
  };
}
