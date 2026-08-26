/**
 * Valuation in context: against the company's own past, and against its peers.
 *
 * An absolute price-to-earnings band cannot be right for everything it is
 * applied to. Scoring every company against a fixed 12-to-35 scale says a
 * utility on 22 and a software company on 22 are equally priced, which is not a
 * claim anyone familiar with either would make. The multiple a business
 * deserves depends on how fast it grows, how reliable the earnings are and what
 * the rest of its industry trades on, and none of that is in a constant.
 *
 * So the same multiple is read two further ways, each answering a question the
 * absolute number cannot:
 *
 *   **Against its own history.** Is this company expensive *for this company*?
 *   A P/E of 28 means one thing for a business that has averaged 30 and another
 *   for one that has averaged 14. This is the comparison least contaminated by
 *   sector fashion, because the business is its own control.
 *
 *   **Against its peers.** Is this company expensive *for its industry*? This
 *   is the one that catches a whole sector rerating, which the history
 *   comparison misses: if an industry doubled its multiple over five years,
 *   every company in it looks fairly priced against its own past and the group
 *   may still be expensive.
 *
 * Neither replaces the absolute band, which is why `score.js` keeps it at a
 * reduced weight. History and peers are both relative measures, and relative
 * measures cannot see a bubble that lifted the company and its industry
 * together. The absolute anchor is the only part that can.
 *
 * ## What this deliberately refuses to do
 *
 * **A negative P/E is not cheap.** A company losing money has no meaningful
 * earnings multiple, and arithmetic will happily produce a very negative number
 * that sorts to the top of a "cheapest" list. Loss-makers are excluded from
 * every series and every peer median here, and score as unavailable rather than
 * as attractive.
 *
 * **A tiny denominator is not a signal.** Earnings near zero send the multiple
 * to absurd heights: a company earning one cent a share at $50 prints a P/E of
 * 5,000. Those are arithmetic artifacts of a rounding error, not valuations, so
 * multiples beyond `IMPLAUSIBLE_MULTIPLE` are dropped from the medians.
 *
 * **The median, never the mean.** P/E distributions are violently right-skewed
 * and a single 400× peer drags a mean somewhere no member of the group sits.
 *
 * **Cheap is not the same as good, and this cannot tell them apart.** A company
 * trading well below its own history is often one whose earnings are falling,
 * and the multiple compresses precisely because the market expects the
 * denominator to shrink. That is the value trap, it looks identical to a
 * bargain on this measure, and the growth and profitability pillars are the
 * only counterweight the model has. Nothing here should be read as a signal to
 * buy anything.
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Beyond this a multiple is an artifact of near-zero earnings, not a valuation.
 *
 * Set where it is because a genuine high-growth company can sustain 100× and a
 * few briefly exceed it, while 200× nearly always means the denominator has
 * collapsed toward zero rather than the price having run away.
 */
export const IMPLAUSIBLE_MULTIPLE = 200;

/**
 * How long after a period ends before its figures could have been acted on.
 *
 * This is an assumption, stated rather than measured, and it is here because
 * the warehouse cannot yet answer the question properly. `fct_financial_knowledge`
 * records when the pipeline first *ingested* a figure, which for a warehouse
 * built in 2026 is 2026 for every row, including the 2021 ones. It says nothing
 * about when the 2021 annual report was actually published.
 *
 * Ninety days is the convention: US annual reports are due 60 to 90 days after
 * the fiscal year ends depending on filer size. Using period_end itself would
 * be lookahead bias, crediting the series with knowing FY2024 earnings on the
 * last day of FY2024, months before anyone could have.
 *
 * When the knowledge table has accumulated real restatement history, this
 * should be replaced by the actual known_from date and this constant deleted.
 */
export const REPORTING_LAG_DAYS = 90;

/** Smallest sample that makes a median worth quoting, per comparison. */
export const MIN_OBSERVATIONS = 24;
export const MIN_PEERS = 5;

const DAY_MS = 86_400_000;

/** Median of a numeric list. Returns null on an empty one. */
export function median(values) {
  const sorted = values.filter(isNum).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Whether a multiple is usable: positive, finite, and not an artifact. */
export const usableMultiple = (v) => isNum(v) && v > 0 && v <= IMPLAUSIBLE_MULTIPLE;

/**
 * The share of `values` at or below `value`, as 0-100.
 *
 * Reported alongside the ratio because it answers a different question. A ratio
 * of 0.8 says the multiple is a fifth below its median; a percentile of 12 says
 * it has only been this cheap an eighth of the time. The second is the more
 * useful sentence when the distribution is lopsided.
 */
export function percentileOf(value, values) {
  const sample = values.filter(isNum);
  if (!isNum(value) || !sample.length) return null;
  return (sample.filter((v) => v <= value).length / sample.length) * 100;
}

/**
 * A point-in-time multiple series: each price divided by the earnings that
 * were publishable at that date.
 *
 * The earnings figure steps once a year rather than each quarter, because the
 * upstream only supplies four annual periods and five quarters, which is not
 * enough to roll a trailing twelve months across a multi-year window. The
 * consequence is honest and worth naming: within a year the series moves only
 * because the price moved, so it tracks price against a fixed denominator
 * between report dates rather than a true rolling TTM multiple.
 *
 * @param {Array} prices    [{ date: 'YYYY-MM-DD', close }] oldest first
 * @param {Array} earnings  [{ date: period_end, eps }] oldest first, annual
 * @returns {Array} [{ date, multiple, eps }] excluding periods with no usable earnings
 */
export function multipleSeries(prices = [], earnings = [], { reportingLagDays = REPORTING_LAG_DAYS } = {}) {
  const reportable = earnings
    .filter((row) => row && row.date && isNum(row.eps))
    .map((row) => ({ ...row, knownFrom: Date.parse(`${row.date}T00:00:00Z`) + reportingLagDays * DAY_MS }))
    .sort((a, b) => a.knownFrom - b.knownFrom);

  if (!reportable.length) return [];

  const series = [];
  for (const point of prices) {
    if (!point || !point.date || !isNum(point.close)) continue;
    const at = Date.parse(`${point.date}T00:00:00Z`);
    if (!Number.isFinite(at)) continue;

    // The most recent report that had been published by this date. Anything
    // later is information the market did not have.
    let applicable = null;
    for (const row of reportable) {
      if (row.knownFrom <= at) applicable = row;
      else break;
    }
    // A loss-making year does not produce a multiple. Skipping the point is
    // right: carrying the previous year's earnings forward would silently
    // value the company on earnings it no longer has.
    if (!applicable || applicable.eps <= 0) continue;

    const multiple = point.close / applicable.eps;
    if (!usableMultiple(multiple)) continue;
    series.push({ date: point.date, multiple, eps: applicable.eps });
  }
  return series;
}

/**
 * Where the current multiple sits against the company's own past.
 *
 * @returns {null|{ median, current, ratio, percentile, observations, from, to }}
 *          null when there is not enough history to say anything.
 */
export function versusOwnHistory(series = [], current, { minObservations = MIN_OBSERVATIONS } = {}) {
  const usable = series.filter((p) => usableMultiple(p.multiple));
  if (usable.length < minObservations || !usableMultiple(current)) return null;

  const multiples = usable.map((p) => p.multiple);
  const mid = median(multiples);
  if (!usableMultiple(mid)) return null;

  return {
    median: mid,
    current,
    // Below 1 means cheaper than it has typically been.
    ratio: current / mid,
    percentile: percentileOf(current, multiples),
    observations: usable.length,
    from: usable[0].date,
    to: usable.at(-1).date,
  };
}

/**
 * Where the current multiple sits against comparable companies.
 *
 * Grouping falls back from industry to sector on purpose. Yahoo's industry
 * taxonomy is fine-grained enough that most of them hold only a handful of the
 * companies scored here: 69 of 111 industries have fewer than five members. A
 * median of two is not a peer comparison, it is a coin toss with extra steps,
 * so a group that thin widens to the sector and says that it did.
 *
 * REITs are compared only against REITs regardless of grouping. A REIT's
 * earnings are suppressed by depreciation on property that is not actually
 * losing value, so REIT P/Es sit structurally higher and comparing one against
 * an operating company is meaningless in either direction.
 *
 * @param {object} self   { symbol, multiple, industry, sector, isReit }
 * @param {Array}  peers  [{ symbol, multiple, industry, sector, isReit }]
 * @returns {null|{ median, current, ratio, percentile, count, basis, group }}
 */
export function versusPeers(self, peers = [], { minPeers = MIN_PEERS } = {}) {
  if (!self || !usableMultiple(self.multiple)) return null;

  const comparable = peers.filter(
    (p) =>
      p &&
      p.symbol !== self.symbol && // a company is not its own peer
      usableMultiple(p.multiple) &&
      Boolean(p.isReit) === Boolean(self.isReit),
  );

  const tryGroup = (basis) => {
    const key = self[basis];
    if (!key) return null;
    const group = comparable.filter((p) => p[basis] === key);
    return group.length >= minPeers ? { basis, group: key, members: group } : null;
  };

  const chosen = tryGroup('industry') ?? tryGroup('sector');
  if (!chosen) return null;

  const multiples = chosen.members.map((p) => p.multiple);
  const mid = median(multiples);
  if (!usableMultiple(mid)) return null;

  return {
    median: mid,
    current: self.multiple,
    // Below 1 means cheaper than the group.
    ratio: self.multiple / mid,
    percentile: percentileOf(self.multiple, multiples),
    count: chosen.members.length,
    basis: chosen.basis,
    group: chosen.group,
  };
}

/**
 * Both readings together, plus why either is missing.
 *
 * The `unavailable` list exists so the interface can say "not enough history"
 * rather than showing a blank where a number should be. A missing comparison
 * that looks like a broken one invites the reader to assume the worst.
 */
export function valuationContext({ series = [], current, self, peers = [], options = {} } = {}) {
  const own = versusOwnHistory(series, current, options);
  const peer = versusPeers(self, peers, options);

  const unavailable = [];
  if (!own) {
    unavailable.push(
      !usableMultiple(current)
        ? 'no positive earnings to price against'
        : `needs ${options.minObservations ?? MIN_OBSERVATIONS} months of history, has ${series.filter((p) => usableMultiple(p.multiple)).length}`,
    );
  }
  if (!peer) {
    unavailable.push(
      !usableMultiple(current)
        ? 'no positive earnings to compare'
        : `fewer than ${options.minPeers ?? MIN_PEERS} comparable companies with a usable multiple`,
    );
  }

  return { own, peers: peer, unavailable };
}
