/**
 * Side-by-side performance maths for the compare view.
 *
 * The point of the view is one number most free tools bury: **how much of a
 * return was the dividend**. Yahoo's `adjClose` is adjusted for splits and
 * distributions, and `close` for splits only, so running both through the same
 * normalisation gives total return against price return exactly, with no
 * reinvestment model of our own to be wrong about.
 *
 * Every series is rebased to the same start date and the same starting amount.
 * Rebasing is the whole comparison: two securities at different prices are not
 * comparable in currency, and an index that starts at 100 while a share starts
 * at 12 makes the share look flat regardless of what it did.
 */

const BASE = 10_000;

/**
 * @param {Map} histories  symbol -> [{ t, close, adjClose }], oldest first
 * @param {object} options
 * @param {number} options.base  starting amount every series is rebased to
 * @returns {{ series, startedAt, base, dropped }}
 */
export function buildComparison(histories, { base = BASE } = {}) {
  const entries = [...histories.entries()].filter(([, points]) => points?.length >= 2);
  const dropped = [...histories.keys()].filter((s) => !entries.some(([symbol]) => symbol === s));

  if (!entries.length) return { series: [], startedAt: null, base, dropped };

  // Start where every symbol has a price. Starting earlier would rebase a
  // late-listing name at its own first close, and its line would then begin
  // partway across the plot at a value that means something different from
  // everyone else's.
  const startedAt = Math.max(...entries.map(([, points]) => points[0].t));

  const series = [];
  for (const [symbol, points] of entries) {
    const window = points.filter((p) => p.t >= startedAt);
    if (window.length < 2) {
      dropped.push(symbol);
      continue;
    }

    const firstClose = window[0].close;
    const firstAdj = window[0].adjClose;
    if (!(firstClose > 0) || !(firstAdj > 0)) {
      dropped.push(symbol);
      continue;
    }

    const price = window.map((p) => ({ t: p.t, c: (p.close / firstClose) * base }));
    const total = window.map((p) => ({ t: p.t, c: (p.adjClose / firstAdj) * base }));

    const priceReturn = (price.at(-1).c / base - 1) * 100;
    const totalReturn = (total.at(-1).c / base - 1) * 100;
    const years = (window.at(-1).t - window[0].t) / (365.25 * 86_400_000);

    series.push({
      symbol,
      price,
      total,
      priceReturn,
      totalReturn,
      // The gap between the two lines is the distribution contribution, in
      // percentage points of the starting amount.
      dividendContribution: totalReturn - priceReturn,
      // What share of the total gain came from distributions rather than price.
      // Undefined when the total return is negative or flat: a "share of" a
      // loss is not a quantity anyone can read, so it is left out instead.
      dividendShare: totalReturn > 0 ? ((totalReturn - priceReturn) / totalReturn) * 100 : null,
      totalCagr: years >= 1 ? ((total.at(-1).c / base) ** (1 / years) - 1) * 100 : null,
      years,
    });
  }

  series.sort((a, b) => b.totalReturn - a.totalReturn);
  return { series, startedAt, base, dropped: [...new Set(dropped)] };
}
