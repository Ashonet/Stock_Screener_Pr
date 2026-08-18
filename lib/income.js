/**
 * Dividend income actually received by a wallet.
 *
 * Two deliberate choices govern every number in here.
 *
 * **Eligibility runs on the ex-dividend date, and the test is strict.** Yahoo's
 * dividend events are ex-dates, not pay dates, and the rule on an ex-date is
 * that the buyer does not receive the distribution: you must already hold the
 * shares the day before. So a payment counts only when its ex-date is strictly
 * after the purchase date. Buying on the ex-date itself pays you nothing, and
 * counting it would overstate the first year of every position.
 *
 * **The share count is today's, held back to the purchase date.** The wallet
 * stores a position, not a ledger of lots, so there is no record of buying 10
 * shares and later topping up to 30. Income is therefore computed as if you
 * had held the current count since the purchase date, which overstates a
 * position that was topped up and understates one that was trimmed. The UI
 * states this rather than presenting the total as a settled fact.
 *
 * A holding with no purchase date is not guessed at. It is excluded and named,
 * because assuming you held it forever would invent income you never received,
 * which is a worse failure than an incomplete total.
 */

/** `2026-03-14` -> `2026-03`. Buckets are calendar months in UTC. */
const monthKey = (isoDate) => isoDate.slice(0, 7);

/** Every month from `first` to `last` inclusive, so quiet months stay visible. */
function monthSpan(first, last) {
  const out = [];
  let [year, month] = first.split('-').map(Number);
  const [lastYear, lastMonth] = last.split('-').map(Number);

  // A gap month with no payment is information: it is the difference between a
  // monthly payer and a quarterly one, and dropping it flattens that away.
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    if (++month > 12) {
      month = 1;
      year++;
    }
  }
  return out;
}

/**
 * @param {Array}  holdings   [{ symbol, shares, boughtAt }]
 * @param {Map}    dividends  symbol -> [{ exDate: 'YYYY-MM-DD', perShare: number }]
 * @param {object} options
 * @param {string} options.asOf  ISO date; payments after it are ignored
 * @returns {{ payments, months, bySymbol, totals, excluded }}
 */
export function buildIncome(holdings, dividends, { asOf = new Date().toISOString().slice(0, 10) } = {}) {
  const payments = [];
  const excluded = [];

  for (const holding of holdings) {
    const { symbol, shares, boughtAt } = holding;

    if (!boughtAt) {
      excluded.push({ symbol, reason: 'no-purchase-date' });
      continue;
    }

    const record = dividends.get(symbol) ?? [];
    if (!record.length) {
      excluded.push({ symbol, reason: 'no-dividend-record' });
      continue;
    }

    const eligible = record.filter((d) => d.exDate > boughtAt && d.exDate <= asOf);
    if (!eligible.length) {
      // Held, and paying, but nothing has gone ex since the purchase. That is
      // an ordinary state for a recent buy, not a data problem.
      excluded.push({ symbol, reason: 'none-since-purchase' });
      continue;
    }

    for (const d of eligible) {
      payments.push({
        symbol,
        exDate: d.exDate,
        perShare: d.perShare,
        shares,
        amount: d.perShare * shares,
      });
    }
  }

  payments.sort((a, b) => (a.exDate === b.exDate ? a.symbol.localeCompare(b.symbol) : b.exDate.localeCompare(a.exDate)));

  /* ------------------------------------------------------------- by month */

  const totalsByMonth = new Map();
  for (const p of payments) {
    const key = monthKey(p.exDate);
    totalsByMonth.set(key, (totalsByMonth.get(key) ?? 0) + p.amount);
  }

  const keys = [...totalsByMonth.keys()].sort();
  const months = keys.length
    ? monthSpan(keys[0], keys.at(-1)).map((month) => ({ month, amount: totalsByMonth.get(month) ?? 0 }))
    : [];

  /* ------------------------------------------------------------ by symbol */

  const perSymbol = new Map();
  for (const p of payments) {
    const row = perSymbol.get(p.symbol) ?? { symbol: p.symbol, amount: 0, payments: 0, firstExDate: p.exDate, lastExDate: p.exDate };
    row.amount += p.amount;
    row.payments += 1;
    if (p.exDate < row.firstExDate) row.firstExDate = p.exDate;
    if (p.exDate > row.lastExDate) row.lastExDate = p.exDate;
    perSymbol.set(p.symbol, row);
  }
  const bySymbol = [...perSymbol.values()].sort((a, b) => b.amount - a.amount);

  /* -------------------------------------------------------------- totals */

  const total = payments.reduce((sum, p) => sum + p.amount, 0);

  // The trailing twelve months, on the same strict boundary as eligibility.
  const yearAgo = new Date(Date.parse(`${asOf}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
  const trailingYear = payments.filter((p) => p.exDate > yearAgo).reduce((sum, p) => sum + p.amount, 0);

  // Only months that have actually completed count toward an average, or the
  // current part-month drags it down every time it is looked at.
  const complete = months.filter((m) => m.month < monthKey(asOf));

  return {
    payments,
    months,
    bySymbol,
    excluded,
    totals: {
      total,
      trailingYear,
      paymentCount: payments.length,
      symbolCount: bySymbol.length,
      monthlyAverage: complete.length ? complete.reduce((sum, m) => sum + m.amount, 0) / complete.length : null,
      bestMonth: months.length ? months.reduce((best, m) => (m.amount > best.amount ? m : best)) : null,
      firstExDate: payments.length ? payments.at(-1).exDate : null,
    },
  };
}
