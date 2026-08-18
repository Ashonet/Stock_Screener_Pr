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
 * @param {Array} entries [{ holding, chart }], chart may be null if it failed
 * @returns {{ points: Array, startedAt: number|null, coverage: Array }}
 */
export function buildValueSeries(entries) {
  const priced = entries.filter((e) => e.chart?.points?.length);
  if (!priced.length) return { points: [], startedAt: null, coverage: [] };

  // Every holding must have a price before the series can start, otherwise the
  // total jumps the day a late-listing holding appears and reads as a gain.
  const startedAt = Math.max(...priced.map((e) => e.chart.points[0].t));

  // Union of every observation time, so a holding on another exchange (or with
  // a missing session) still contributes rather than truncating the spine.
  const times = [...new Set(priced.flatMap((e) => e.chart.points.map((p) => p.t)))]
    .filter((t) => t >= startedAt)
    .sort((a, b) => a - b);

  // Walk each series once, carrying the last known close forward.
  const cursors = priced.map(() => 0);
  const lastClose = priced.map(() => null);

  const points = [];
  for (const t of times) {
    let value = 0;
    let complete = true;

    priced.forEach((entry, i) => {
      const list = entry.chart.points;
      while (cursors[i] < list.length && list[cursors[i]].t <= t) {
        lastClose[i] = list[cursors[i]].c;
        cursors[i]++;
      }
      if (lastClose[i] == null) complete = false;
      else value += lastClose[i] * entry.holding.shares;
    });

    if (complete) points.push({ t, c: value });
  }

  return {
    points,
    startedAt: points[0]?.t ?? null,
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
