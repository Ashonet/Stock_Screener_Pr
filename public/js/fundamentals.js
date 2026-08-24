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
 * **AFFO is shown as a range, because a single figure would be wrong.**
 *
 * True AFFO is FFO less *recurring maintenance* capex. The statement feed
 * carries one capital expenditure line, covering maintenance and growth
 * together, and nothing in it separates the two. For a landlord that spends
 * almost nothing the distinction hardly matters: Realty Income and VICI report
 * no capex line at all, and Welltower's is 1% of FFO. For a REIT that builds it
 * decides the answer. American Tower spends 37% of FFO on capex and Equinix
 * spends 126% of it, so subtracting the whole line gives Equinix a negative
 * AFFO, which is not a hard number to interpret so much as a wrong one.
 *
 * So both estimates are drawn and neither is called AFFO on its own:
 *
 *   FFO less capex        treats every pound of growth spending as if it were
 *                         maintenance, so it understates a REIT that is building
 *   Operating cash flow   subtracts no capex at all, and carries working capital
 *                         movements that AFFO excludes
 *
 * Which reads higher is not fixed. For a builder like American Tower the cash
 * flow line is far above the other; for VICI, which spends almost nothing on
 * capex, it is below it, because working capital moved against them. The pair
 * brackets the answer in the usual case rather than bounding it in every case,
 * and the real figure is published in the company's own supplemental, which
 * this warehouse does not read. Showing both is the honest version of an answer
 * we do not have.
 *
 * The quality score keeps using operating cash flow alone for every REIT,
 * because its payout column is compared *between* REITs and a measure that
 * changed definition per company would make that column mean two things at
 * once. These charts compare a company against its own past, where a band is
 * more useful than a false precision.
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
 * AFFO: FFO less the capital expenditure needed to keep the portfolio earning.
 *
 * Capex is reported as a negative number, so its magnitude is taken. This is
 * the standard approximation rather than a company's own definition: a real
 * AFFO reconciliation also normalises straight-line rent and amortises leasing
 * costs, and none of that reaches the statement feed. It is closer than
 * operating cash flow, which ignores capex entirely, and further from the truth
 * than the figure in the company's supplemental.
 */
const affo = (row) => {
  const base = ffo(row);
  return isNum(base) && isNum(row.capitalExpenditure) ? base - Math.abs(row.capitalExpenditure) : null;
};

/**
 * @param {Array}  rows   statement rows, oldest first
 * @param {string} basis  'reit' | 'standard'
 * @returns {{ charts, unavailable, basis }}
 */
export function fundamentalCharts(rows = [], basis = 'standard') {
  const usable = rows.filter((row) => row?.date);
  if (!usable.length) return { charts: [], unavailable: [], basis };

  const reit = basis === 'reit';

  const periods = usable.map((row) => row.date);

  /** A spec, dropped entirely when nothing in the series has a value. */
  const chart = (spec) => {
    const values = usable.map((row) => spec.value(row));
    return values.some(isNum) ? { ...spec, values, periods } : null;
  };

  /**
   * Two series on one axis, for a quantity that is a band rather than a number.
   *
   * Both must be in the same unit, which they are: two estimates of the same
   * thing. Dropped unless at least one of them has a value somewhere.
   */
  const band = (spec) => {
    const series = spec.series
      .map((entry) => ({ name: entry.name, values: usable.map((row) => entry.value(row)) }))
      .filter((entry) => entry.values.some(isNum));
    return series.length ? { ...spec, series, periods } : null;
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

  // The two estimates, drawn side by side rather than blended into one line,
  // because the gap between them is mostly the growth spending and that is the
  // thing a reader most needs to see. Neither is reliably the larger.
  const affoFloor = (row) => affo(row);
  const affoCeiling = (row) => row.operatingCashFlow;

  const reitCharts = [
    chart({ key: 'ffo', title: 'FFO', kind: 'currency', value: ffo, note: 'Net income plus depreciation and amortisation.' }),
    chart({
      key: 'ffoPerShare',
      title: 'FFO per share',
      kind: 'perShare',
      value: (row) => div(ffo(row), row.dilutedAverageShares),
      note: 'The figure a REIT is actually valued on, and the one share issuance can dilute while total FFO still rises.',
    }),
    band({
      key: 'affo',
      title: 'AFFO range',
      kind: 'currency',
      series: [
        { name: 'FFO less capex', value: affoFloor },
        { name: 'Operating cash flow', value: affoCeiling },
      ],
      note:
        'AFFO is FFO less recurring maintenance capex, and the statement feed carries one capex line covering maintenance and growth together. So the lower bar treats all growth spending as maintenance and the upper subtracts no capex at all. The real figure sits between them, in the company\u2019s own supplemental, which this does not read.',
    }),
    band({
      key: 'affoPerShare',
      title: 'AFFO per share range',
      kind: 'perShare',
      series: [
        { name: 'FFO less capex', value: (row) => div(affoFloor(row), row.dilutedAverageShares) },
        { name: 'Operating cash flow', value: (row) => div(affoCeiling(row), row.dilutedAverageShares) },
      ],
      note: 'What the dividend is paid out of, per share, on both estimates.',
    }),
    band({
      key: 'affoPayout',
      title: 'Payout against AFFO range',
      kind: 'percent',
      series: [
        {
          name: 'Of FFO less capex',
          value: (row) => pct(isNum(row.cashDividendsPaid) ? Math.abs(row.cashDividendsPaid) : null, affoFloor(row)),
        },
        {
          name: 'Of operating cash flow',
          value: (row) => pct(isNum(row.cashDividendsPaid) ? Math.abs(row.cashDividendsPaid) : null, affoCeiling(row)),
        },
      ],
      note:
        'The number a REIT investor watches, on both estimates. Against earnings the same dividend routinely reads over 100% and looks like distress when nothing is wrong. Measured against FFO less capex it can also exceed 100% for a REIT that is building, which is growth spending rather than an unaffordable dividend.',
    }),
    chart({
      key: 'capex',
      title: 'Capital expenditure',
      kind: 'currency',
      value: (row) => (isNum(row.capitalExpenditure) ? Math.abs(row.capitalExpenditure) : null),
      note: 'Most of the gap between the two AFFO estimates. Maintenance and growth are not separated in the feed, so a rising line can be either a portfolio getting older or one getting bigger.',
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
    // Whether both estimates exist. A REIT reporting no capex line has only the
    // cash flow one, and the card should not promise a range it cannot draw.
    affoBounded: reit ? usable.some((row) => isNum(affo(row))) : null,
    // Named rather than silently missing. A reader looking for occupancy should
    // be told it is not obtainable here, not left to conclude the company does
    // not report it.
    unavailable: reit
      ? ['Occupancy', 'Same-store NOI', 'Releasing spread', 'Weighted average lease term']
      : [],
  };
}
