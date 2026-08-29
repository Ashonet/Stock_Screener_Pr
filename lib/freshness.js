/**
 * When the stored data being shown was actually stored.
 *
 * The detail view falls back to the warehouse whenever the live feed is
 * rate-limited, and labels the result rather than passing it off as live. That
 * label carries a date, and the date has to describe the thing it is attached
 * to.
 *
 * It previously did not. The banner read `priceAsOf ?? asOf`, taking the last
 * day the market traded, which is the wrong quantity twice over: only
 * fundamentals and statements are ever served from storage, and the same
 * sentence goes on to say prices are current. So a profile fetched on Monday
 * morning was labelled with Friday's close, reading as three days stale while
 * the prices it sat beside were live.
 *
 * A trade date is not an ingest time. It moves when the market opens, not when
 * this pipeline ran, and the two answer different questions.
 */

/**
 * @param {string[]} served  which kinds came from storage: 'fundamentals', 'financials'
 * @param {object}   stored  { asOf, financialsAsOf } ingest timestamps
 * @returns {string|null}    ISO timestamp of the most recent relevant ingest
 */
export function storedAsOf(served = [], stored = {}) {
  const candidates = [
    served.includes('fundamentals') ? stored.asOf : null,
    served.includes('financials') ? stored.financialsAsOf : null,
  ];

  const dates = candidates
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()));

  if (!dates.length) return null;

  // The most recent, because the banner names everything it is covering and a
  // reader should not be told the oldest of them applies to all.
  return dates.sort((a, b) => b - a)[0].toISOString();
}
