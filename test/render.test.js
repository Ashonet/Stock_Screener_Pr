/**
 * Smoke test: the wallet view actually runs.
 *
 * This exists because of a bug nothing else could see. `renderMix` called
 * `compactCurrency` without importing it, which is valid syntax, so
 * `node --check` passed. The import checker verifies that every imported name
 * is really exported and cannot see a name that was never imported at all. And
 * the failure only fired on the render path where a wallet had priced holdings,
 * where it was caught by the loader's try/catch, blanked the valuation and
 * reported itself as "could not value this wallet".
 *
 * A reference error is not a subtle bug. It just needs the code to be *run*
 * once, which nothing did, because every other test here targets pure
 * functions.
 *
 * So this stubs enough of a DOM to execute the real render path against fixture
 * data. It asserts almost nothing about the output on purpose: its whole job is
 * to fail if a module throws, and asserting on markup would make it break every
 * time a class name changed.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------- the stub DOM */

class StubNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.hidden = false;
    this.textContent = '';
    // Non-zero, so charts size themselves rather than taking the empty branch.
    this.clientWidth = 800;
    this.clientHeight = 300;
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  append(...children) {
    this.children.push(...children.filter(Boolean));
  }
  replaceChildren(...children) {
    this.children = children.flatMap((c) => (c instanceof StubFragment ? c.children : [c])).filter(Boolean);
  }
  setAttribute() {}
  getAttribute() {
    return null;
  }
  removeAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  remove() {}
  focus() {}
  querySelector() {
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 300 };
  }
}

class StubFragment extends StubNode {}

function installDom() {
  globalThis.Node = StubNode;
  globalThis.document = {
    createElement: (tag) => new StubNode(tag),
    createElementNS: (_ns, tag) => new StubNode(tag),
    createTextNode: (text) => Object.assign(new StubNode('#text'), { textContent: String(text) }),
    createDocumentFragment: () => new StubFragment('#fragment'),
    getElementById: () => new StubNode('div'),
    querySelector: () => new StubNode('div'),
    documentElement: new StubNode('html'),
    body: new StubNode('body'),
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#2a78d6' });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    // Charts repaint when the system flips between light and dark, which they
    // learn from the media query rather than an attribute.
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
}

/* ----------------------------------------------------------------- fixtures */

const DAY = 86_400_000;
const start = Date.UTC(2024, 0, 1);
const series = (from, n, base) => Array.from({ length: n }, (_, i) => ({ t: from + i * 30 * DAY, c: base * (1 + i / 50) }));

const wallet = {
  id: 'w1',
  name: 'Sam',
  holdings: [
    { symbol: 'O', shares: 100, cost: 49.5, boughtAt: '2024-01-10' },
    { symbol: 'KO', shares: 50, cost: 60, boughtAt: '2024-06-01' },
    { symbol: 'JNJ', shares: 20, cost: 150, boughtAt: null },
  ],
};

const portfolio = {
  range: '1y',
  currency: 'USD',
  points: series(start, 20, 10_000),
  startedAt: start,
  startReason: 'purchase',
  firstPurchase: start,
  contributions: [{ symbol: 'KO', t: Date.UTC(2024, 5, 1) }],
  holdings: [
    { symbol: 'O', name: 'Realty Income', currency: 'USD', shares: 100, cost: 49.5, boughtAt: '2024-01-10', price: 62, previousClose: 61, changePercent: 1.6, value: 6200, dayChange: 100, costTotal: 4950, gain: 1250, gainPercent: 25.3, weight: 40 },
    { symbol: 'KO', name: 'Coca-Cola', currency: 'USD', shares: 50, cost: 60, boughtAt: '2024-06-01', price: 70, previousClose: 69, changePercent: 1.4, value: 3500, dayChange: 50, costTotal: 3000, gain: 500, gainPercent: 16.7, weight: 25 },
    { symbol: 'JNJ', name: 'Johnson & Johnson', currency: 'USD', shares: 20, cost: null, boughtAt: null, price: 270, previousClose: 268, changePercent: 0.7, value: 5400, dayChange: 40, costTotal: null, gain: null, gainPercent: null, weight: 35 },
  ],
  totals: { value: 15_100, dayChange: 190, dayChangePercent: 1.3, costTotal: 7950, gain: 1750, gainPercent: 22, costCoverage: 2 / 3 },
  unpriced: [],
};

const income = {
  payments: [
    { symbol: 'O', exDate: '2025-06-30', perShare: 0.27, shares: 100, amount: 27 },
    { symbol: 'KO', exDate: '2025-06-15', perShare: 0.51, shares: 50, amount: 25.5 },
  ],
  months: [
    { month: '2025-05', amount: 0 },
    { month: '2025-06', amount: 52.5 },
  ],
  bySymbol: [
    { symbol: 'O', amount: 27, payments: 1, firstExDate: '2025-06-30', lastExDate: '2025-06-30' },
    { symbol: 'KO', amount: 25.5, payments: 1, firstExDate: '2025-06-15', lastExDate: '2025-06-15' },
  ],
  excluded: [{ symbol: 'JNJ', reason: 'no-purchase-date' }],
  totals: { total: 52.5, trailingYear: 52.5, paymentCount: 2, symbolCount: 2, monthlyAverage: 26.25, bestMonth: { month: '2025-06', amount: 52.5 }, firstExDate: '2025-06-15' },
  projection: {
    rows: [
      { symbol: 'O', shares: 100, perShareTrailing: 3.2, currentAnnual: 320, growthPct: 3.5, yearsOfGrowth: 5, fastGrowth: false, projected: [{ year: 1, amount: 331 }, { year: 5, amount: 380 }] },
      { symbol: 'KO', shares: 50, perShareTrailing: 2.04, currentAnnual: 102, growthPct: null, yearsOfGrowth: 1, fastGrowth: false, projected: [{ year: 1, amount: 102 }, { year: 5, amount: 102 }] },
    ],
    byYear: [{ year: 1, amount: 433 }, { year: 5, amount: 482 }],
    excluded: [{ symbol: 'JNJ', reason: 'no-dividend-record' }],
    years: 5,
    totals: { currentAnnual: 422, finalYear: 482, blendedGrowth: 2.7, ratedShare: 76 },
  },
};

const score = {
  points: series(start, 20, 70).map((p) => ({ t: p.t, c: 60 + (p.c % 20), coverage: 100 })),
  startedAt: start,
  current: { score: 72.6, coverage: 100, gradedHoldings: 3 },
  holdings: [
    { symbol: 'O', value: 6200, score: 76, grade: 'B+', asOf: '2025-12-31', weight: 41 },
    { symbol: 'JNJ', value: 5400, score: 79, grade: 'B+', asOf: '2025-12-31', weight: 36 },
    { symbol: 'KO', value: 3500, score: 60, grade: 'C+', asOf: '2025-12-31', weight: 23 },
  ],
  excluded: [],
};

const facets = {
  available: true,
  facets: {
    O: { name: 'Realty Income', sector: 'Real Estate', industry: 'REIT - Retail', country: 'United States', isReit: true, grade: 'B+', score: 76, basis: 'reit' },
    KO: { name: 'Coca-Cola', sector: 'Consumer Defensive', industry: 'Beverages - Non-Alcoholic', country: 'United States', isReit: false, grade: 'C+', score: 60, basis: 'standard' },
    JNJ: { name: 'Johnson & Johnson', sector: 'Healthcare', industry: 'Drug Manufacturers - General', country: 'United States', isReit: false, grade: 'B+', score: 79, basis: 'standard' },
  },
  unknown: [],
};

/* ---------------------------------------------------- compare view fixtures */

const gradeStudy = {
  basis: 'then',
  graded: 504,
  asOf: '2026-08-25',
  windows: [
    {
      years: 1,
      available: true,
      start: '2025-08-25',
      universeMean: 34.4,
      universeCount: 502,
      spread: -56.4,
      topGrade: 'A+',
      bottomGrade: 'F',
      rows: [
        {
          grade: 'A+',
          count: 2,
          totalReturn: 4,
          medianReturn: 10.7,
          annualisedReturn: 4,
          positive: 1,
          best: { symbol: 'PLD', totalReturn: 37.7 },
          worst: { symbol: 'COIN', totalReturn: -53.1 },
          members: [
            { symbol: 'PLD', totalReturn: 37.7 },
            { symbol: 'COIN', totalReturn: -53.1 },
          ],
        },
        {
          grade: 'F',
          count: 1,
          totalReturn: 60.5,
          medianReturn: 19.5,
          annualisedReturn: 60.5,
          positive: 1,
          best: { symbol: 'MU', totalReturn: 720.2 },
          worst: { symbol: 'MU', totalReturn: 720.2 },
          // A grade with no member list must not break the disclosure.
          members: [],
        },
      ],
    },
    { years: 10, available: false, reason: 'price history does not reach back this far' },
  ],
  gradeOrder: ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D', 'F'],
};

const comparison = {
  base: 10_000,
  startedAt: start,
  years: 5,
  unavailable: [],
  dropped: [],
  series: [
    {
      symbol: 'O',
      name: 'Realty Income',
      years: 5,
      priceReturn: 3.8,
      totalReturn: 39.8,
      dividendContribution: 36,
      dividendShare: 90.4,
      totalCagr: 5.8,
      price: series(start, 20, 10_000),
      total: series(start, 20, 10_000),
    },
    {
      symbol: 'KO',
      name: 'Coca-Cola',
      years: 5,
      priceReturn: 75.6,
      totalReturn: 110.2,
      dividendContribution: 34.6,
      dividendShare: 31.4,
      totalCagr: 13.3,
      price: series(start, 20, 10_000),
      total: series(start, 20, 10_000),
    },
  ],
};

const dips = {
  windowDays: 365,
  dipping: 1,
  excluded: [],
  rows: [
    {
      symbol: 'VICI',
      name: 'VICI Properties',
      grade: 'A+',
      score: 89,
      price: 25.96,
      high: 33.78,
      low: 25.93,
      asOf: '2026-08-25',
      offHigh: -23.15,
      offLow: 0.12,
      rangePosition: 0.4,
      yieldPct: 6.83,
      avgYieldPct: 5.15,
      yieldVsAverage: 1.326,
      vsCost: -19.7,
    },
    {
      // A token payer: no yield ratio, and no cost basis on record either.
      symbol: 'MSFT',
      name: 'Microsoft',
      grade: 'A+',
      score: 88,
      price: 480.35,
      high: 542.07,
      low: 352.83,
      asOf: '2026-08-25',
      offHigh: -11.39,
      offLow: 36.14,
      rangePosition: 67.3,
      yieldPct: 0.73,
      avgYieldPct: 0.79,
      yieldVsAverage: null,
      vsCost: null,
    },
    {
      // Listed inside the window, so it has no band to sit in.
      symbol: 'NEW',
      name: null,
      grade: null,
      score: null,
      price: 50,
      high: 50,
      low: null,
      asOf: '2026-08-25',
      offHigh: 0,
      offLow: null,
      rangePosition: null,
      yieldPct: null,
      avgYieldPct: null,
      yieldVsAverage: null,
      vsCost: null,
    },
  ],
};

const PANELS = ['hero', 'chart', 'holdings', 'income', 'incomeChart', 'forecast', 'forecastChart', 'goal', 'goalChart', 'score', 'scoreChart', 'mix', 'dips'];

let renderWallet;
let renderCompare;
let chartCard;

before(async () => {
  installDom();
  ({ renderWallet } = await import('../public/js/wallet.js'));
  ({ renderCompare } = await import('../public/js/compare.js'));
  ({ chartCard } = await import('../public/js/charts.js'));
});

const nodes = () => Object.fromEntries(PANELS.map((key) => [key, new StubNode('div')]));

const draw = (over = {}) => {
  const panes = nodes();
  renderWallet({
    nodes: panes,
    wallet,
    data: portfolio,
    income,
    score,
    facets,
    dips,
    mix: { facet: 'sector' },
    rangeBlurb: '1 year',
    handlers: new Proxy({}, { get: () => () => {} }),
    editing: null,
    mountChart: (container, config) => chartCard(container, config),
    forecastYears: 5,
    goal: { target: 30_000, rate: 3, years: 20, returnPct: null },
    ...over,
  });
  return panes;
};

describe('the wallet view runs', () => {
  test('every panel renders something', () => {
    const panes = draw();
    const empty = PANELS.filter((key) => panes[key].children.length === 0);
    assert.deepEqual(empty, [], `these panels rendered nothing: ${empty.join(', ')}`);
  });

  test('the value chart and holdings both fill, which is the tab that broke', () => {
    const panes = draw();
    assert.ok(panes.chart.children.length > 0, 'value chart');
    assert.ok(panes.holdings.children.length > 0, 'holdings table');
  });

  test('the hero carries its trend column, not just the value and the rail', () => {
    // The middle column is the whole reason the hero is a three-column grid.
    // If heroTrend returns null the layout silently collapses back to the
    // mostly-empty card it replaced, and nothing else would notice.
    const panes = draw();
    assert.equal(panes.hero.children.length, 3, 'identity, trend, side');
  });

  test('the trend column is dropped rather than drawn empty', () => {
    // One point is not a line, and a sparkline of nothing is worse than a gap.
    const panes = draw({ data: { ...portfolio, points: [], holdings: [] }, income: null });
    assert.equal(panes.hero.children.length, 2, 'falls back to two columns');
  });

  test('the dip finder renders, including the rows that have nothing to show', () => {
    // Three shapes in one table: a full row, a token payer with no yield ratio
    // and no cost basis, and a symbol with no band to sit in.
    const panes = draw();
    assert.ok(panes.dips.children.length > 0);
  });

  test('every breakdown facet renders', () => {
    for (const facet of ['symbol', 'sector', 'industry', 'grade', 'basis', 'country']) {
      const panes = draw({ mix: { facet } });
      assert.ok(panes.mix.children.length > 0, `facet ${facet}`);
    }
  });

  test('an empty wallet renders rather than throwing', () => {
    const panes = draw({ wallet: { id: 'w2', name: 'Empty', holdings: [] }, data: null, income: null, score: null, dips: null });
    assert.ok(panes.hero.children.length > 0);
  });

  test('a wallet whose side data has not arrived yet still renders', () => {
    // The first paint after selecting a wallet: prices are in, everything else
    // is still in flight.
    const panes = draw({ income: null, score: null, facets: null, dips: null });
    assert.ok(panes.chart.children.length > 0);
    assert.ok(panes.holdings.children.length > 0);
  });

  test('no warehouse means a degraded breakdown, not a crash', () => {
    const panes = draw({ facets: { available: false, facets: {}, unknown: ['O', 'KO', 'JNJ'] } });
    assert.ok(panes.mix.children.length > 0);
  });
});

describe('the compare view runs', () => {
  const paint = (over = {}) => {
    const node = new StubNode('div');
    renderCompare({
      node,
      data: comparison,
      grades: gradeStudy,
      state: { symbols: ['O', 'KO'], years: 5, mode: 'total', tab: 'tickers', grades: { basis: 'then', years: 1 } },
      handlers: new Proxy({}, { get: () => () => {} }),
      ...over,
    });
    return node;
  };

  test('the ticker tab renders', () => {
    assert.ok(paint().children.length > 0);
  });

  test('the grade tab renders, with its expandable rows', () => {
    // This is the case that would have caught a missing `direction` import: the
    // member rows are built only on this tab, and only when a grade has members.
    const node = paint({
      state: { symbols: [], years: 5, mode: 'total', tab: 'grades', grades: { basis: 'then', years: 1 } },
    });
    assert.ok(node.children.length > 0);
  });

  test('a grade with no members does not break the row', () => {
    const node = paint({
      state: { symbols: [], years: 5, mode: 'total', tab: 'grades', grades: { basis: 'now', years: 1 } },
    });
    assert.ok(node.children.length > 0);
  });

  test('a window with no data renders the empty state', () => {
    const node = paint({
      grades: { ...gradeStudy, windows: [{ years: 10, available: false, reason: 'no data' }] },
      state: { symbols: [], years: 5, mode: 'total', tab: 'grades', grades: { basis: 'then', years: 10 } },
    });
    assert.ok(node.children.length > 0);
  });

  test('nothing loaded yet renders a loading state rather than throwing', () => {
    assert.ok(paint({ data: null, grades: null }).children.length > 0);
    assert.ok(
      paint({
        grades: null,
        state: { symbols: [], years: 5, mode: 'total', tab: 'grades', grades: { basis: 'then', years: 1 } },
      }).children.length > 0,
    );
  });
});
