/**
 * The charts a company's statements can actually support, by scoring basis.
 *
 * Pure: rows in, chart specs out. No DOM, no colour, no formatting.
 *
 * **A REIT is not charted like an operating company**, for the same reason it
 * is not scored like one. Depreciation on property that is typically holding or
 * gaining value pushes reported earnings far below the cash produced, so a
 * chart of a REIT's net income and EPS shows a business in trouble when nothing
 * is wrong. Realty Income earns roughly a quarter of its FFO in net income. So
 * the REIT set leads with FFO and cash flow and leaves EPS out, and the
 * operating set leads with earnings.
 *
 * ## What is not here, and why
 *
 * **Occupancy is not available.** Nor is same-store NOI, releasing spread,
 * weighted average lease term, or any other REIT operating metric. They are
 * disclosed in supplementals and earnings decks, not in the financial
 * statements this warehouse is built from, and the upstream does not carry
 * them. A chart cannot be drawn from data nobody has, and inventing a proxy and
 * calling it occupancy would be worse than the gap. The UI says so rather than
 * leaving the reader to wonder.
 *
 * **AFFO is approximated by operating cash flow**, which is the same proxy the
 * quality score uses and is labelled as a proxy in both places. True AFFO is
 * FFO less recurring maintenance capex, and the upstream reports no capex line
 * for a material share of REITs, so a real AFFO cannot be computed for all of
 * them. Applying the proxy uniformly keeps REITs comparable with each other,
 * which mixing real AFFO for some with a proxy for others would not.
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const div = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? a / b : null);
const pct = (a, b) => {
  const ratio = div(a, b);
  return ratio == null ? null : ratio * 100;
};

/** FFO: the REIT earnings replacement, net income plus depreciation. */
const ffo = (row) =>
  isNum(row.netIncome) && isNum(row.depreciationAndAmortization)
    ? row.netIncome + row.depreciationAndAmortization
    : null;

const netDebt = (row) => (isNum(row.totalDebt) ? row.totalDebt - (row.cashAndCashEquivalents ?? 0) : null);

/**
 * @param {Array}  rows   statement rows, oldest first
 * @param {string} basis  'reit' | 'standard'
 * @returns {{ charts, unavailable, basis }}
 */
export function fundamentalCharts(rows = [], basis = 'standard') {
  const usable = rows.filter((row) => row?.date);
  if (!usable.length) return { charts: [], unavailable: [], basis };

  const reit = basis === 'reit';

  /** A spec, dropped entirely when nothing in the series has a value. */
  const chart = (spec) => {
    const values = usable.map((row) => spec.value(row));
    return values.some(isNum) ? { ...spec, values, periods: usable.map((row) => row.date) } : null;
  };

  const shared = [
    chart({
      key: 'revenue',
      title: reit ? 'Rental and total revenue' : 'Revenue',
      kind: 'currency',
      value: (row) => row.totalRevenue,
    }),
    chart({
      key: 'operatingCashFlow',
      title: 'Operating cash flow',
      kind: 'currency',
      value: (row) => row.operatingCashFlow,
      note: reit ? 'Stands in for AFFO throughout this app, which is an approximation and labelled as one.' : null,
    }),
    chart({
      key: 'freeCashFlow',
      title: 'Free cash flow',
      kind: 'currency',
      value: (row) => row.freeCashFlow,
      note: 'Absent where the upstream reports no capital expenditure line, which happens for some REITs.',
    }),
    chart({
      key: 'debtToAssets',
      title: 'Debt to assets',
      kind: 'percent',
      value: (row) => pct(row.totalDebt, row.totalAssets),
    }),
    chart({
      key: 'netDebtToEbitda',
      title: 'Net debt to EBITDA',
      kind: 'multiple',
      value: (row) => div(netDebt(row), row.ebitda),
      note: reit
        ? 'Four and a half to eight times is ordinary for a REIT and would be stretched for an operating company.'
        : 'One to four and a half times is the usual band for an operating company.',
    }),
    chart({
      key: 'interestCoverage',
      title: reit ? 'Interest coverage (EBITDA)' : 'Interest coverage (EBIT)',
      kind: 'multiple',
      value: (row) => div(reit ? row.ebitda : row.ebit, isNum(row.interestExpense) ? Math.abs(row.interestExpense) : null),
      note: reit
        ? 'Measured before depreciation: charging a REIT for a non-cash cost it never funds roughly halves the apparent figure.'
        : null,
    }),
    chart({
      key: 'shares',
      title: 'Shares outstanding',
      kind: 'count',
      value: (row) => row.dilutedAverageShares,
      note: reit
        ? 'A REIT distributes most of its income, so growth is usually funded by issuing shares. A rising count is the cost of that growth and is why per-share figures matter more than totals.'
        : 'A falling count is buybacks, which lift per-share figures without the business growing.',
    }),
  ];

  const reitCharts = [
    chart({ key: 'ffo', title: 'FFO', kind: 'currency', value: ffo, note: 'Net income plus depreciation and amortisation.' }),
    chart({
      key: 'ffoPerShare',
      title: 'FFO per share',
      kind: 'perShare',
      value: (row) => div(ffo(row), row.dilutedAverageShares),
      note: 'The figure a REIT is actually valued on, and the one share issuance can dilute while total FFO still rises.',
    }),
    chart({
      key: 'affoPerShare',
      title: 'Cash flow per share (AFFO proxy)',
      kind: 'perShare',
      value: (row) => div(row.operatingCashFlow, row.dilutedAverageShares),
    }),
    chart({
      key: 'payout',
      title: 'Payout of operating cash flow',
      kind: 'percent',
      value: (row) => pct(isNum(row.cashDividendsPaid) ? Math.abs(row.cashDividendsPaid) : null, row.operatingCashFlow),
      note: 'Against cash flow rather than earnings. A REIT routinely pays out over 100% of EPS and is perfectly sound.',
    }),
    chart({ key: 'ffoMargin', title: 'FFO margin', kind: 'percent', value: (row) => pct(ffo(row), row.totalRevenue) }),
  ];

  const standardCharts = [
    chart({ key: 'netIncome', title: 'Earnings', kind: 'currency', value: (row) => row.netIncome }),
    chart({ key: 'eps', title: 'Diluted EPS', kind: 'perShare', value: (row) => row.dilutedEPS }),
    chart({
      key: 'bookValue',
      title: 'Book value',
      kind: 'currency',
      value: (row) => row.stockholdersEquity,
      note: "Shareholders' equity: assets less liabilities, as the balance sheet carries them.",
    }),
    chart({
      key: 'bookValuePerShare',
      title: 'Book value per share',
      kind: 'perShare',
      value: (row) => div(row.stockholdersEquity, row.dilutedAverageShares),
    }),
    chart({
      key: 'margins',
      title: 'Operating margin',
      kind: 'percent',
      value: (row) => pct(row.operatingIncome, row.totalRevenue),
    }),
    chart({
      key: 'netMargin',
      title: 'Net margin',
      kind: 'percent',
      value: (row) => pct(row.netIncome, row.totalRevenue),
    }),
    chart({
      key: 'payout',
      title: 'Payout of free cash flow',
      kind: 'percent',
      value: (row) => pct(isNum(row.cashDividendsPaid) ? Math.abs(row.cashDividendsPaid) : null, row.freeCashFlow),
    }),
    chart({
      key: 'returnOnEquity',
      title: 'Return on equity',
      kind: 'percent',
      value: (row) => pct(row.netIncome, row.stockholdersEquity),
    }),
  ];

  // The basis-specific set leads, because it is the one that describes the
  // business; the shared set follows.
  const charts = [...(reit ? reitCharts : standardCharts), ...shared].filter(Boolean);

  return {
    charts,
    basis,
    // Named rather than silently missing. A reader looking for occupancy should
    // be told it is not obtainable here, not left to conclude the company does
    // not report it.
    unavailable: reit
      ? ['Occupancy', 'Same-store NOI', 'Releasing spread', 'Weighted average lease term']
      : [],
  };
}
