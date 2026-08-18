/**
 * Quality scorer.
 *
 * Five pillars, dividend safety, balance sheet, growth, profitability,
 * valuation. Each 0-100, combined into a weighted overall score and a letter
 * grade.
 *
 * The point of this file is that **a REIT is not scored like an operating
 * company**. For a REIT, net income is pushed down by depreciation on buildings
 * that are typically holding or gaining value, so EPS, P/E and an
 * earnings-based payout ratio all read as alarming when nothing is wrong.
 * Realty Income pays out roughly 250% of EPS and is perfectly sound. So the
 * REIT path swaps in:
 *
 *   earnings   -> FFO (net income + depreciation & amortisation)
 *   P/E        -> P/FFO
 *   payout/EPS -> payout / operating cash flow (an AFFO proxy)
 *   leverage   -> the same net-debt/EBITDA test, at REIT-appropriate levels
 *
 * These are heuristic thresholds for screening, not a validated model, and
 * every input is exposed in the UI so a reader can disagree with the grade.
 *
 * FFO here is the standard approximation, net income + D&A. True NAREIT FFO
 * also strips gains on property sales and adds back impairments; Yahoo does not
 * report those lines, so a REIT that sold a lot of property in a given year
 * will score with an inflated FFO. Flagged as estimated in the UI.
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const abs = (v) => (isNum(v) ? Math.abs(v) : null);
const div = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? a / b : null);

/** Yahoo files REITs under industries that all begin "REIT - ...". */
export function isREIT(profile = {}) {
  return /^\s*REIT\b/i.test(profile.industry ?? '');
}

/**
 * Map a value onto 0-100 by linear interpolation between a "poor" and a
 * "great" anchor. Works in either direction: pass great < poor when lower is
 * better (payout ratio, leverage, P/E).
 */
function scoreBetween(value, poor, great) {
  if (!isNum(value)) return null;
  const span = great - poor;
  if (span === 0) return null;
  return Math.max(0, Math.min(100, ((value - poor) / span) * 100));
}

/** Compound annual growth rate across a series, ignoring gaps. */
function cagr(values) {
  const clean = values.filter(isNum);
  if (clean.length < 2) return null;
  const first = clean[0];
  const last = clean.at(-1);
  const years = clean.length - 1;
  // A sign flip (a loss year at either end) makes a growth rate meaningless.
  if (first <= 0 || last <= 0) return null;
  return ((last / first) ** (1 / years) - 1) * 100;
}

/**
 * Trailing-twelve-month dividend totals at yearly anniversaries of the most
 * recent payment, oldest first.
 *
 * Calendar-year totals are unreliable here: for a monthly payer, whether a
 * payment lands on 31 Dec or 1 Jan swings the year by a whole distribution and
 * shows up as a cut that never happened, Realty Income's 2024 calendar total
 * sits 6% below 2023 for exactly that reason, despite raising throughout.
 * A rolling window counts the same number of payments every time.
 */
function trailingYearTotals(payments, windows = 11) {
  if (!payments?.length || payments.length < 2) return [];

  // Bucket by payment *count* rather than by date. A date boundary that falls
  // beside a payment puts 5 quarters in one window and 3 in the next, which
  // reads as a cut followed by a raise; a company's payments-per-year cadence
  // is stable, so counting them is exact.
  const gaps = [];
  for (let i = 1; i < payments.length; i++) gaps.push(payments[i].t - payments[i - 1].t);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  if (!medianGap) return [];
  const perYear = Math.max(1, Math.min(12, Math.round((365.25 * 86_400_000) / medianGap)));

  const totals = [];
  for (let k = 0; k < windows; k++) {
    const end = payments.length - k * perYear;
    const start = end - perYear;
    if (start < 0) break;
    totals.push(payments.slice(start, end).reduce((sum, p) => sum + p.amount, 0));
  }
  return totals.reverse();
}

/** Consecutive rolling years of dividend increases, counted back from today. */
function growthStreak(totals) {
  let streak = 0;
  for (let i = totals.length - 1; i > 0; i--) {
    if (totals[i] > totals[i - 1] * 1.001) streak++; // tolerance for float noise
    else break;
  }
  return { streak, yearsObserved: Math.max(0, totals.length - 1) };
}

/**
 * Payout averaged over the last three reported years.
 *
 * A single year is too jumpy to grade on: Coca-Cola's 2025 free cash flow was
 * held down by a one-off multi-billion tax deposit, which alone would print a
 * 166% payout on an otherwise well-covered dividend.
 */
function averagePayout(rows, useOperatingCashFlow) {
  const cashOf = (r) => (useOperatingCashFlow ? r.operatingCashFlow : r.freeCashFlow);
  const usable = rows.filter((r) => isNum(r.cashDividendsPaid) && isNum(cashOf(r)));
  if (!usable.length) return null;
  const paid = usable.reduce((sum, r) => sum + Math.abs(r.cashDividendsPaid), 0);
  const cash = usable.reduce((sum, r) => sum + cashOf(r), 0);
  return cash > 0 ? (paid / cash) * 100 : null;
}

/** Combine sub-metrics into a pillar, renormalising over whatever has data. */
function pillar(title, basis, parts) {
  const scored = parts.filter((p) => isNum(p.score));
  const weightSum = scored.reduce((sum, p) => sum + p.weight, 0);
  return {
    title,
    basis,
    score: weightSum > 0 ? Math.round(scored.reduce((sum, p) => sum + p.score * p.weight, 0) / weightSum) : null,
    metrics: parts.map(({ label, display, score, hint }) => ({
      label,
      display,
      score: isNum(score) ? Math.round(score) : null,
      hint: hint ?? null,
    })),
  };
}

const GRADES = [
  [88, 'A+'],
  [80, 'A'],
  [73, 'B+'],
  [66, 'B'],
  [58, 'C+'],
  [50, 'C'],
  [40, 'D'],
];
const grade = (score) => GRADES.find(([floor]) => score >= floor)?.[1] ?? 'F';

const BAND = [
  [75, 'Strong'],
  [60, 'Solid'],
  [45, 'Mixed'],
  [30, 'Weak'],
];
const band = (score) => BAND.find(([floor]) => score >= floor)?.[1] ?? 'Poor';

/* --------------------------------------------------------------- formatting */

const pct = (v, digits = 1) => (isNum(v) ? `${v.toFixed(digits)}%` : null);
const mult = (v, digits = 1) => (isNum(v) ? `${v.toFixed(digits)}×` : null);
const money = (v) => {
  if (!isNum(v)) return null;
  const a = Math.abs(v);
  const [size, suffix] = a >= 1e12 ? [1e12, 'T'] : a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1, ''];
  return `${v < 0 ? '-' : ''}$${(a / size).toFixed(a / size >= 100 ? 0 : 2)}${suffix}`;
};

/* -------------------------------------------------------------------- model */

const WEIGHTS = { dividend: 0.25, balance: 0.25, growth: 0.2, profitability: 0.15, valuation: 0.15 };

/**
 * @param {object} args
 * @param {object} args.summary          raw quoteSummary modules
 * @param {Array}  args.financials       annual rows, oldest first
 * @param {Array}  args.dividendPayments raw {t, amount} payments, oldest first
 */
export function buildScore({ summary = {}, financials = [], dividendPayments = [] }) {
  const detail = summary.summaryDetail ?? {};
  const stats = summary.defaultKeyStatistics ?? {};
  const fin = summary.financialData ?? {};
  const priceMod = summary.price ?? {};
  const company = summary.summaryProfile ?? {};

  const reit = isREIT(company);
  const rows = financials.filter((r) => r && r.date);
  const latest = rows.at(-1) ?? {};
  const recent = rows.slice(-5);

  const marketCap = num(priceMod.marketCap) ?? num(detail.marketCap);
  const price = num(fin.currentPrice) ?? num(priceMod.regularMarketPrice);

  /* ---- derived fundamentals ---- */

  const netIncome = latest.netIncome;
  const da = latest.depreciationAndAmortization;
  const cfo = latest.operatingCashFlow;
  const fcf = latest.freeCashFlow;
  const revenue = latest.totalRevenue;
  const dividendsPaid = abs(latest.cashDividendsPaid);
  const shares = latest.dilutedAverageShares;

  // FFO, the REIT earnings replacement.
  const ffo = isNum(netIncome) && isNum(da) ? netIncome + da : null;
  const ffoPerShare = div(ffo, shares);
  const priceToFFO = div(marketCap, ffo);

  // The cash a payout is actually made from. For a REIT that is AFFO, which is
  // FFO less recurring capex, but Yahoo reports no capex line for a material
  // share of REITs (Realty Income and Prologis among them), so a true AFFO is
  // not computable for all of them. Operating cash flow stands in, applied
  // uniformly: mixing real AFFO for some REITs with a proxy for others would
  // make the payout ratio incomparable between them. An operating company has
  // a dependable capex line, so free cash flow is the honest denominator there.
  const distributable = reit ? cfo : fcf;
  const payoutRatio = averagePayout(rows.slice(-3), reit);
  const payoutYears = rows.slice(-3).filter((r) => isNum(r.cashDividendsPaid)).length;

  const netDebt = isNum(latest.totalDebt) ? latest.totalDebt - (latest.cashAndCashEquivalents ?? 0) : null;
  const netDebtToEbitda = div(netDebt, latest.ebitda);
  // Coverage is measured before depreciation for a REIT. Using EBIT charges a
  // REIT for non-cash depreciation it never has to fund, which halves the
  // apparent coverage: Realty Income reads 2.0× on EBIT and 4.3× on EBITDA,
  // and the second is the one that reflects its ability to pay interest.
  const interestCover = div(reit ? latest.ebitda : latest.ebit, abs(latest.interestExpense));
  const debtToAssets = div(latest.totalDebt, latest.totalAssets);

  const revenueCagr = cagr(recent.map((r) => r.totalRevenue));
  const perShareCagr = reit
    ? cagr(recent.map((r) => div(isNum(r.netIncome) && isNum(r.depreciationAndAmortization) ? r.netIncome + r.depreciationAndAmortization : null, r.dilutedAverageShares)))
    : cagr(recent.map((r) => r.dilutedEPS));

  const rollingDividends = trailingYearTotals(dividendPayments);
  const dividendCagr = cagr(rollingDividends.slice(-6));
  const { streak, yearsObserved } = growthStreak(rollingDividends);

  const trailingPE = num(detail.trailingPE) ?? num(stats.trailingPE);
  const currentYield = num(detail.dividendYield) == null ? null : num(detail.dividendYield) * 100;
  const avgYield = num(detail.fiveYearAvgDividendYield);
  const yieldVsHistory = div(currentYield, avgYield);
  const fcfYield = div(fcf, marketCap) == null ? null : div(fcf, marketCap) * 100;
  const ffoYield = div(ffo, marketCap) == null ? null : div(ffo, marketCap) * 100;

  const ebitdaMargin = div(latest.ebitda, revenue) == null ? null : div(latest.ebitda, revenue) * 100;
  const ffoMargin = div(ffo, revenue) == null ? null : div(ffo, revenue) * 100;
  const operatingMargin = div(latest.operatingIncome, revenue) == null ? null : div(latest.operatingIncome, revenue) * 100;
  const roe = num(fin.returnOnEquity) == null ? null : num(fin.returnOnEquity) * 100;

  // Two separate questions, previously conflated.
  //
  // Is the dividend a real claim on cash flow, worth grading for safety? Apple
  // yields only 0.35% but pays out ~15% of free cash flow with a long raise
  // record, so yes. NVIDIA's is a rounding error on both counts, so no, and
  // its weight goes to the other pillars.
  const paysDividend =
    isNum(currentYield) && currentYield > 0 && (currentYield >= 0.25 || (isNum(payoutRatio) && payoutRatio >= 5));

  // Is the yield large enough for "yield vs its own history" to mean anything?
  // At a 0.02% yield that ratio is noise, NVIDIA reads 8.8× its five-year
  // average purely because both numbers round to nothing, so below 1% the
  // valuation pillar falls back to a cash-flow yield instead.
  const yieldHistoryUsable = isNum(currentYield) && currentYield >= 1 && isNum(avgYield) && avgYield > 0;

  /* ---- pillars ---- */

  const pillars = [
    pillar(
      'Dividend safety',
      !paysDividend
        ? 'No material dividend, not scored'
        : reit
          ? 'Payout measured against operating cash flow (AFFO proxy)'
          : 'Payout measured against free cash flow',
      [
        {
          label: reit ? 'Payout / cash flow' : 'Payout / free cash flow',
          display: !paysDividend || payoutRatio == null ? null : `${pct(payoutRatio)} (${payoutYears}y avg)`,
          // REITs must distribute 90% of taxable income, so a high payout is
          // structural rather than a warning sign.
          score: paysDividend ? scoreBetween(payoutRatio, reit ? 100 : 90, reit ? 70 : 40) : null,
          weight: 0.55,
          hint: reit
            ? 'REITs are required to distribute most of their income, so the safe band sits far higher than for an operating company.'
            : 'Share of free cash flow paid out as dividends.',
        },
        {
          label: 'Years of consecutive raises',
          display: paysDividend ? `${streak} of ${yearsObserved}` : null,
          score: paysDividend ? scoreBetween(streak, 0, 10) : null,
          weight: 0.45,
          hint: 'Measured on rolling 12-month totals, so a monthly payer is not penalised for payment timing.',
        },
      ],
    ),

    pillar('Balance sheet', reit ? 'Leverage judged on REIT norms' : 'Leverage judged on operating-company norms', [
      {
        label: 'Net debt / EBITDA',
        display: mult(netDebtToEbitda),
        score: scoreBetween(netDebtToEbitda, reit ? 8 : 4.5, reit ? 4.5 : 1),
        weight: 0.5,
        hint: reit
          ? 'Property is debt-financed by design; 5-6× is normal for a REIT.'
          : 'Under 2× is conservative for an operating company.',
      },
      {
        label: 'Interest coverage',
        display: mult(interestCover),
        score: scoreBetween(interestCover, reit ? 2 : 3, reit ? 5.5 : 15),
        weight: 0.3,
        hint: reit
          ? 'EBITDA divided by interest expense. Depreciation is not a cash cost, so it is added back before testing coverage.'
          : 'Operating profit divided by interest expense.',
      },
      {
        label: 'Debt / assets',
        display: pct(debtToAssets == null ? null : debtToAssets * 100),
        score: scoreBetween(debtToAssets, reit ? 0.65 : 0.6, reit ? 0.3 : 0.2),
        weight: 0.2,
      },
    ]),

    pillar('Growth', reit ? 'Per-share growth measured on FFO' : 'Per-share growth measured on EPS', [
      { label: 'Revenue CAGR', display: pct(revenueCagr), score: scoreBetween(revenueCagr, 0, 12), weight: 0.35 },
      {
        label: reit ? 'FFO / share CAGR' : 'EPS CAGR',
        display: pct(perShareCagr),
        score: scoreBetween(perShareCagr, 0, 10),
        weight: 0.4,
      },
      {
        label: 'Dividend CAGR',
        display: paysDividend ? pct(dividendCagr) : null,
        score: paysDividend ? scoreBetween(dividendCagr, 0, 8) : null,
        weight: 0.25,
      },
    ]),

    pillar('Profitability', reit ? 'Cash-based margins' : 'Earnings-based margins', [
      reit
        ? { label: 'EBITDA margin', display: pct(ebitdaMargin), score: scoreBetween(ebitdaMargin, 40, 70), weight: 0.5 }
        : {
            label: 'Operating margin',
            display: pct(operatingMargin),
            score: scoreBetween(operatingMargin, 5, 30),
            weight: 0.5,
          },
      reit
        ? {
            label: 'FFO margin',
            display: pct(ffoMargin),
            score: scoreBetween(ffoMargin, 30, 65),
            weight: 0.5,
            hint: 'FFO as a share of revenue.',
          }
        : { label: 'Return on equity', display: pct(roe), score: scoreBetween(roe, 5, 25), weight: 0.5 },
    ]),

    pillar('Valuation', reit ? 'Priced on FFO, not earnings' : 'Priced on earnings', [
      reit
        ? {
            label: 'P / FFO',
            display: mult(priceToFFO),
            score: scoreBetween(priceToFFO, 28, 13),
            weight: 0.6,
            hint: 'The REIT equivalent of P/E. A REIT P/E is not comparable to an operating company.',
          }
        : { label: 'P / E (TTM)', display: mult(trailingPE), score: scoreBetween(trailingPE, 35, 12), weight: 0.6 },
      yieldHistoryUsable
        ? {
            label: 'Yield vs 5-year average',
            display: yieldVsHistory == null ? null : `${yieldVsHistory.toFixed(2)}×`,
            score: scoreBetween(yieldVsHistory, 0.7, 1.3),
            weight: 0.4,
            hint: 'Above 1.0× means the shares yield more than their own recent history: cheaper on this measure.',
          }
        : {
            label: reit ? 'FFO yield' : 'Free cash flow yield',
            display: pct(reit ? ffoYield : fcfYield),
            score: scoreBetween(reit ? ffoYield : fcfYield, 2, 8),
            weight: 0.4,
          },
    ]),
  ];

  /* ---- overall ---- */

  const keys = ['dividend', 'balance', 'growth', 'profitability', 'valuation'];
  const weighted = pillars
    .map((p, i) => ({ score: p.score, weight: WEIGHTS[keys[i]] }))
    .filter((p) => isNum(p.score));
  const coverage = weighted.reduce((sum, p) => sum + p.weight, 0);
  const overall =
    coverage >= 0.4
      ? Math.round(weighted.reduce((sum, p) => sum + p.score * p.weight, 0) / coverage)
      : null;

  return {
    basis: reit ? 'reit' : 'standard',
    industry: company.industry ?? null,
    overall,
    grade: overall == null ? null : grade(overall),
    band: overall == null ? null : band(overall),
    coverage: Math.round(coverage * 100),
    pillars,
    // Shown beside the grade so the swapped-in metrics are visible, not implied.
    keyFigures: reit
      ? [
          { label: 'FFO (last FY)', value: money(ffo), hint: 'Net income + depreciation & amortisation.' },
          { label: 'FFO / share', value: isNum(ffoPerShare) ? `$${ffoPerShare.toFixed(2)}` : null },
          { label: 'P / FFO', value: mult(priceToFFO) },
          { label: 'Cash flow payout', value: pct(payoutRatio) },
        ]
      : [
          { label: 'EPS (last FY)', value: isNum(latest.dilutedEPS) ? `$${latest.dilutedEPS.toFixed(2)}` : null },
          { label: 'Free cash flow', value: money(fcf) },
          { label: 'P / E (TTM)', value: mult(trailingPE) },
          { label: 'FCF payout', value: pct(payoutRatio) },
        ],
    paysDividend,
  };
}

/** Local copy of the {raw,fmt} unwrapper so this module stands alone. */
function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && 'raw' in v) {
    const n = Number(v.raw);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
