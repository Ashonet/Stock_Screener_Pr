/**
 * Income goal: what the portfolio has to be worth to pay you what you want,
 * and how much of that would come from dividends rather than from selling.
 *
 * The model is one line of arithmetic and one assumption. The arithmetic is
 * that a portfolio drawn at `w` percent a year supports `value x w` of income,
 * so a target income needs `target / w` of capital. The assumption is the
 * withdrawal rate itself, and it is doing all the work: at 3% a $30,000 income
 * needs a million, at 4% it needs 750,000. That is a quarter of a working life
 * of difference resting on a number nobody can verify in advance, so the rate
 * is a control rather than a constant, and it is stated on the card.
 *
 * **Dividends are not extra income on top of the withdrawal.** They are the
 * part of it that arrives without selling anything. If the portfolio yields 3%
 * and you draw 3%, you sell nothing; if it yields 1.2%, the other 1.8% has to
 * come from selling shares. That is the split this reports, because "how much
 * do I have to sell" is the question a dividend investor is actually asking,
 * and the answer is not the yield and not the withdrawal rate but the gap
 * between them.
 *
 * The yield is assumed to hold as the portfolio grows, which is the weakest
 * part of the projection: a portfolio that grows mostly through price
 * appreciation ends up yielding less on cost than it does today, and would
 * need to sell more than this suggests.
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const YEAR_MS = 365.25 * 86_400_000;

/**
 * @param {object} args
 * @param {number} args.value             portfolio value now
 * @param {number} args.annualDividends   forward annual dividends at today's holdings
 * @param {number} args.target            wanted annual income
 * @param {number} [args.withdrawalRate]  percent drawn per year
 * @param {number} [args.startValue]      value at the first purchase
 * @param {number} [args.startedAt]       ms of the first purchase
 * @param {number} [args.dividendsReceived] total received since then
 * @param {number} [args.contributions]   holdings that joined after the start
 * @param {number} [args.now]             ms, for testing
 */
export function buildGoal({
  value,
  annualDividends = 0,
  target,
  withdrawalRate = 3,
  startValue = null,
  startedAt = null,
  dividendsReceived = null,
  contributions = 0,
  now = Date.now(),
}) {
  if (!isNum(value) || value <= 0) return { ok: false, reason: 'no-value' };
  if (!isNum(target) || target <= 0) return { ok: false, reason: 'no-target' };
  if (!isNum(withdrawalRate) || withdrawalRate <= 0) return { ok: false, reason: 'no-rate' };

  const rate = withdrawalRate / 100;
  const requiredValue = target / rate;

  // Yield on today's value, not on cost. What matters for the split is what the
  // holdings pay against what they are worth, since that is what scales as the
  // portfolio grows.
  const yieldPct = (annualDividends / value) * 100;

  /** Split a withdrawal into the part dividends cover and the part you sell. */
  const split = (portfolioValue) => {
    const withdrawal = portfolioValue * rate;
    const dividends = portfolioValue * (yieldPct / 100);
    // Dividends above the withdrawal are not a shortfall of anything; they are
    // income you did not have to sell for, and the excess simply stays.
    const fromDividends = Math.min(dividends, withdrawal);
    const fromSales = Math.max(0, withdrawal - dividends);
    return {
      withdrawal,
      dividends,
      fromDividends,
      fromSales,
      surplus: Math.max(0, dividends - withdrawal),
      // The part of the rate that has to be sold: the user's "3% minus
      // whatever the dividend is".
      saleRatePct: Math.max(0, withdrawalRate - yieldPct),
      coveredPct: withdrawal > 0 ? Math.min(100, (dividends / withdrawal) * 100) : null,
    };
  };

  const today = split(value);
  const atTarget = split(requiredValue);

  /* -------------------------------------------------- since the first buy */

  const years = isNum(startedAt) ? Math.max(0, (now - startedAt) / YEAR_MS) : null;
  const grewBy = isNum(startValue) && startValue > 0 ? (value / startValue - 1) * 100 : null;

  /*
   * An annualised rate is a return, and this one would not be.
   *
   * The wallet's first point is the first holding alone, and later holdings
   * join the series on their own purchase dates. So the change from then to now
   * is capital added plus whatever it earned, and reporting it compounded reads
   * as performance: a wallet that went from 3,550 to 16,089 by buying more
   * would print "42% a year", which it never made. Without a per-lot ledger the
   * two cannot be separated, so where money was added the rate is withheld
   * rather than published with a caveat nobody reads.
   */
  const withContributions = contributions > 0;
  const annualisedPct =
    !withContributions && isNum(startValue) && startValue > 0 && years >= 1
      ? ((value / startValue) ** (1 / years) - 1) * 100
      : null;

  return {
    ok: true,
    target,
    withdrawalRate,
    requiredValue,
    value,
    annualDividends,
    yieldPct,
    shortfall: Math.max(0, requiredValue - value),
    progressPct: Math.min(100, (value / requiredValue) * 100),
    // Dividends alone would cover the goal at this yield once the portfolio is
    // worth this much, which is the no-selling version of the same target.
    valueForDividendsAlone: yieldPct > 0 ? target / (yieldPct / 100) : null,
    today,
    atTarget,
    sinceStart: {
      startValue,
      startedAt,
      years,
      grewBy,
      annualisedPct,
      // Whether that change includes money paid in after the start, which is
      // the difference between "the wallet grew" and "the wallet returned".
      withContributions,
      contributions,
      dividendsReceived,
    },
  };
}
