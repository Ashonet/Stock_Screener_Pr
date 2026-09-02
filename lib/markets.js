/**
 * The indices on the market strip.
 *
 * Shared with the pipeline rather than declared beside the route, because the
 * strip is only as good as what has been extracted for it. When these lived in
 * server.js alone, nothing fetched them: the six tiles were drawn from live
 * quotes and had no stored form at all, so the one thing on the page that never
 * changes shape was also the only thing with nothing to fall back on. A rate
 * limit blanked all six while every company on the page kept its price.
 *
 * An index is fetched as a wide-tier symbol: daily closes and nothing else.
 * There are no statements to fetch and nothing to score.
 */
export const MARKET_INDICES = [
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^IXIC', label: 'Nasdaq' },
  { symbol: '^DJI', label: 'Dow Jones' },
  { symbol: '^RUT', label: 'Russell 2000' },
  { symbol: '^VIX', label: 'VIX' },
  { symbol: '^TNX', label: '10-Year yield' },
];

export const MARKET_INDEX_SYMBOLS = MARKET_INDICES.map((index) => index.symbol);
