/**
 * Portfolio ("wallet") maths: combine per-symbol price history into one value
 * series, and price the current holdings.
 *
 * The chart answers "what has this basket been worth?", holding the share
 * counts fixed at what they are today. It is deliberately *not* a
 * transaction-ledger backtest: the share count is today's throughout, so the
 * series shows the value of today's holdings at historical prices. The UI says
 * as much next to the chart, because the two are easy to confuse and only one
 * of them is what this computes.
 *
 * A holding may carry a purchase date. It does not change the value series (a
 * ledger replay is still out of scope); it exists so dividend income can be
 * attributed only to payments that happened while you actually held the shares.
 */

/**
 * An ISO `YYYY-MM-DD` that is a real calendar date and not in the future.
 *
 * The round-trip check matters: `new Date('2025-02-30')` rolls forward to
 * 2 March rather than failing, so parsing alone would silently accept a day
 * that never existed and attribute income from it.
 */
/**
 * A number that is genuinely present, or null.
 *
 * `Number(null)` and `Number('')` are both 0, not NaN, so the obvious
 * `Number.isFinite(Number(x))` test treats "no cost basis given" as "bought at
 * zero". That reported the whole position as gain. Absence is checked before
 * conversion, never after.
 */
function optionalNumber(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseDate(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  if (new Date(ms).toISOString().slice(0, 10) !== text) return null;
  return ms > Date.now() ? null : text;
}

/**
 * `AAPL:10:150.25:2024-03-08` -> { symbol, shares, cost, boughtAt }.
 *
 * Cost and purchase date are both optional, and the cost slot may be empty so
 * a date can be given without one (`AAPL:10::2024-03-08`).
 */
export function parseHoldings(raw, { max = 40 } = {}) {
  const out = [];
  const seen = new Set();

  for (const part of String(raw ?? '').split(',')) {
    const [rawSymbol, rawShares, rawCost, rawBought] = part.split(':');
    const symbol = String(rawSymbol ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9.^=-]{1,20}$/.test(symbol) || seen.has(symbol)) continue;

    const shares = Number(rawShares);
    if (!Number.isFinite(shares) || shares <= 0) continue;

    seen.add(symbol);
    out.push({
      symbol,
      shares,
      cost: optionalNumber(rawCost),
      boughtAt: parseDate(rawBought),
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Build the combined value series.
 *
 * **Each holding joins the line on the day it was bought.** Valuing the whole
 * basket from the earliest purchase date counted shares that had not been
 * bought yet: a wallet holding one position from June and two more from January
 * opened at the value of all three in June, so the line started at 11,387 on a
 * position that cost 5,500, and the difference looked like a gain that had
 * already happened. A holding with no purchase date on record is held from the
 * start, since there is nothing to say otherwise.
 *
 * The consequence is that the line steps up when a holding is added, and that
 * step is money paid in rather than a return. Contribution dates are returned
 * so the chart can say so; a value series and a return series are different
 * things and this is the first.
 *
 * @param {Array} entries [{ holding, chart }], chart may be null if it failed
 * @param {object} [options]
 * @param {boolean} [options.fromPurchaseDates] bring holdings in on their
 *   purchase dates rather than valuing all of them throughout
 * @returns {{ points, startedAt, startReason, firstPurchase, contributions, coverage }}
 */
export function buildValueSeries(entries, { fromPurchaseDates = true } = {}) {
  const priced = entries.filter((e) => e.chart?.points?.length);
  if (!priced.length) {
    return { points: [], startedAt: null, startReason: null, firstPurchase: null, contributions: [], coverage: [] };
  }

  // The day each holding starts counting. Without a date it counts throughout,
  // which is the old behaviour and the only honest default: an unknown purchase
  // date is not evidence of a late one.
  const heldFrom = priced.map((e) => {
    if (!fromPurchaseDates || !e.holding.boughtAt) return -Infinity;
    const t = Date.parse(`${e.holding.boughtAt}T00:00:00Z`);
    return Number.isFinite(t) ? t : -Infinity;
  });

  const dated = heldFrom.filter((t) => t !== -Infinity);
  const firstPurchase = dated.length ? Math.min(...dated) : null;

  // Union of every observation time, so a holding on another exchange (or with
  // a missing session) still contributes rather than truncating the spine.
  const times = [...new Set(priced.flatMap((e) => e.chart.points.map((p) => p.t)))].sort((a, b) => a - b);

  // Walk each series once, carrying the last known close forward.
  const cursors = priced.map(() => 0);
  const lastClose = priced.map(() => null);

  const points = [];
  // Why the first point lands where it does, decided by what actually stopped
  // the earlier ones rather than inferred afterwards. Comparing the start
  // against the purchase date would get this wrong every time someone bought on
  // a weekend: the date is a Saturday, the first point is the Monday.
  let firstReason = null;
  let skippedUnheld = false;

  for (const t of times) {
    let value = 0;
    let held = 0;
    let complete = true;

    priced.forEach((entry, i) => {
      const list = entry.chart.points;
      // Advance regardless of whether it is held yet, so the cursor is in the
      // right place on the day it starts counting.
      while (cursors[i] < list.length && list[cursors[i]].t <= t) {
        lastClose[i] = list[cursors[i]].c;
        cursors[i]++;
      }
      if (t < heldFrom[i]) return;
      held++;
      // A holding that is owned but has no price yet would drop out of the
      // total and read as a loss, so the whole point is withheld instead.
      if (lastClose[i] == null) complete = false;
      else value += lastClose[i] * entry.holding.shares;
    });

    if (held === 0) {
      skippedUnheld = true;
      continue;
    }
    if (!complete) continue;
    if (!points.length) firstReason = skippedUnheld ? 'purchase' : 'coverage';
    points.push({ t, c: value });
  }

  const startedAt = points[0]?.t ?? null;

  // Every date after the first on which a holding joins, which is where the
  // line steps for a reason that is not performance.
  const contributions = priced
    .map((entry, i) => ({ symbol: entry.holding.symbol, t: heldFrom[i] }))
    .filter((c) => c.t !== -Infinity && startedAt != null && c.t > startedAt)
    .sort((a, b) => a.t - b.t);

  return {
    points,
    startedAt,
    // Why the line begins where it does, so the chart can say which of the two
    // reasons applies instead of asserting one of them.
    startReason: points.length ? firstReason : null,
    firstPurchase,
    contributions,
    coverage: entries.map((e) => ({ symbol: e.holding.symbol, priced: Boolean(e.chart?.points?.length) })),
  };
}

/** Current value, day change and gain/loss per holding, plus the totals. */
export function priceHoldings(holdings, quotes) {
  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));

  const rows = holdings.map((h) => {
    const quote = bySymbol.get(h.symbol) ?? {};
    const price = quote.price ?? null;
    const value = price == null ? null : price * h.shares;
    const dayChange = quote.change == null ? null : quote.change * h.shares;
    const costTotal = h.cost == null ? null : h.cost * h.shares;
    const gain = value == null || costTotal == null ? null : value - costTotal;

    return {
      symbol: h.symbol,
      name: quote.name ?? h.symbol,
      currency: quote.currency ?? 'USD',
      shares: h.shares,
      cost: h.cost,
      boughtAt: h.boughtAt ?? null,
      price,
      previousClose: quote.previousClose ?? null,
      changePercent: quote.changePercent ?? null,
      value,
      dayChange,
      costTotal,
      gain,
      gainPercent: gain == null || !costTotal ? null : (gain / costTotal) * 100,
    };
  });

  const sum = (pick) => {
    const values = rows.map(pick).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };

  const value = sum((r) => r.value);
  const dayChange = sum((r) => r.dayChange);
  // Only holdings that actually carry a cost basis count toward the total, so a
  // half-filled wallet reports gain on the part it can rather than a wrong whole.
  const costRows = rows.filter((r) => r.costTotal != null && r.value != null);
  const costTotal = costRows.length ? costRows.reduce((a, r) => a + r.costTotal, 0) : null;
  const costValue = costRows.length ? costRows.reduce((a, r) => a + r.value, 0) : null;
  const gain = costTotal == null ? null : costValue - costTotal;

  // Weights are of the priced total, so they always sum to 100%.
  for (const row of rows) row.weight = value && row.value != null ? (row.value / value) * 100 : null;

  const previousValue = value != null && dayChange != null ? value - dayChange : null;

  return {
    rows: rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1)),
    totals: {
      value,
      dayChange,
      dayChangePercent: previousValue ? (dayChange / previousValue) * 100 : null,
      costTotal,
      gain,
      gainPercent: costTotal ? (gain / costTotal) * 100 : null,
      costCoverage: rows.length ? costRows.length / rows.length : 0,
    },
  };
}
