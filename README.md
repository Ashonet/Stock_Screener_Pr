# Stock analytics platform

An end-to-end analytics stack over public equity data: an incremental extraction
pipeline, a dbt warehouse with data-quality tests, and a dashboard and screener
served from the marts.

**No API key, no paid data source, no infrastructure to provision.** Extraction
reads Yahoo Finance's public endpoints; the warehouse is DuckDB; orchestration is
a nightly GitHub Actions cron.

```
GitHub Actions (nightly, 22:30 UTC weekdays)
        │
        ├─ extract      Node · incremental by watermark · warehouse/raw/*.jsonl.gz
        │                 append-only landing zone, gzipped and committed
        │
        ├─ dbt build    4 staging views → 6 marts
        │                 dim_security · fct_prices · fct_financials
        │                 fct_dividends · int_dividend_windows · mart_quality_score
        │
        └─ dbt test     51 assertions · 7 of them written from real bugs
                              │
                    warehouse.duckdb (derived, gitignored)
                              │
              Node server reads the marts — no upstream calls at request time
```

Tracks the **full S&P 500** — 503 tickers, since the index carries dual share
classes.

Why batch rather than live: the upstream rate-limits by IP. A live proxy works
on a laptop and falls over on a shared host. Scoring 503 companies from four
years of statements each is a few thousand upstream calls; against the mart it
is one local query, which is what makes the screener possible at all.

### The constituent list is fetched, never typed

`pipeline/build-universe.js` pulls the S&P 500 from a published source and then
**validates every ticker against Yahoo before admitting it**, because index
membership is not the same as data availability — companies get renamed, and a
hand-written list rots silently into missing additions and dead tickers. Symbols
that fail to resolve are dropped and named in `universe.json` rather than
disappearing quietly. All 503 currently resolve.

---

## Data quality, and the bug behind each test

This is the part worth reading. Every assertion below exists because something
was silently wrong, and none of them were failing loudly — the numbers looked
plausible, which is what made them dangerous.

| Test | The bug it came from |
|---|---|
| `assert_dividend_years_contiguous` | Yahoo caps the dividend event list at 168 entries on `range=max` and drops the **middle**. Coca-Cola returned 1962–2003, then 2026 — two decades missing behind a chart that looked fine. Fixed by requesting an explicit period window. |
| `assert_ebitda_present_with_revenue` | The extractor lower-cased only the first character of Yahoo's metric names, so `annualEBITDA` became `eBITDA`. It resolved to null on **every company**, blanking net-debt/EBITDA, interest coverage and EBITDA margin. Nothing errored; the balance-sheet pillar just quietly scored on one input instead of three. |
| `assert_no_phantom_dividend_cut` | Dividend growth was measured on calendar-year totals, which misreads every monthly payer: whether a distribution lands on 31 Dec or 1 Jan swings the year by a whole payment. Realty Income's 2024 calendar total sits 6% below 2023 *while it was raising throughout*. Fixed by bucketing on payment count (`int_dividend_windows`). |
| `assert_payout_ratio_sane` | The payout ratio came from a single reported year. Coca-Cola's 2025 free cash flow was held down by a one-off multi-billion tax deposit, printing a 166% payout on a well-covered dividend. Now averaged over three years. |
| `assert_grade_matches_score` | The letter grade was derived from the unrounded score while the card displayed the rounded one, so they disagreed at every boundary: 72.6 printed as "73" and graded as B, where the published ladder says 73 is a B+. |
| `assert_reit_affo_proxy_still_needed` | Records why AFFO is approximated by operating cash flow, and fails if the reason stops holding. |
| `assert_prices_are_fresh` | A pipeline that silently stops is worse than one that fails, because the dashboard keeps serving stale prices as current. |

Three of those tests were themselves wrong on first contact with the full
universe, which is the honest part of the story:

- **Contiguity was a false positive on T-Mobile**, which paid one special
  dividend in 2013 and nothing until it initiated a regular payout in 2023 — a
  genuine ten-year gap, not lost data. The test now only fires when the company
  was a *regular* payer on both sides of the gap, which is what distinguishes
  truncation from suspension.
- **The EBITDA test flagged five banks.** EBITDA is not meaningful for them —
  interest is revenue, not a financing cost to add back — so financials are
  exempt, otherwise a real regression would be buried under expected nulls.
- **"Yahoo reports no capex for REITs" turned out to be false.** It was inferred
  from two tickers. Across the universe, 9 of 13 REITs do report capex. The AFFO
  proxy is still applied uniformly — mixing a true AFFO for some REITs with a
  proxy for others would make the payout column incomparable, and a screener
  that is not comparable is worthless — but the claim in the code and docs was
  wrong and is now corrected.

Running `dbt build` currently gives **50 pass, 1 warn**. The warning is Texas
Instruments and Eli Lilly above 200% FCF payout, which is real: both are in
heavy capex cycles. A warning that stays on deliberately is more useful than one
tuned until it disappears.

---

## The warehouse

| Model | Grain | Notes |
|---|---|---|
| `stg_*` | raw | `read_json_auto` over the landing zone, reading `.jsonl` and `.jsonl.gz` through one glob. Every numeric goes through `try_cast`, because Yahoo signals "no value" with an empty object (`market_cap: {}` for Salesforce), and a direct cast fails the whole build on one bad cell. |
| `dim_security` | symbol | Defines `is_reit` once. Every downstream branch reads it rather than re-deriving. |
| `fct_prices` | symbol × date | **Incremental**, merged on the key. The extract deliberately re-fetches a week of overlap so Yahoo's restatements land and correct in place rather than duplicating. |
| `fct_financials` | symbol × period | Pivoted from long form. Statement coverage varies by industry — a railway reports no R&D — so raw stays long and widening happens here. |
| `fct_dividends` | symbol × pay date | Infers payment cadence from the **median gap over recent payments**. Agree Realty moved from quarterly to monthly in 2021; a median across its full record infers 11 payments a year, which is neither. |
| `int_dividend_windows` | symbol × window | Trailing totals bucketed by payment count, not calendar year. The model that fixes the monthly-payer bug. |
| `mart_quality_score` | symbol | The scoring model. Serving contract for the dashboard and screener. |

### The scoring model, and why REITs branch

`mart_quality_score` grades five pillars — dividend safety 25%, balance sheet
25%, growth 20%, profitability 15%, valuation 15% — into a 0-100 score and a
letter grade. A pillar with no data is dropped and its weight redistributed,
with the resulting coverage reported.

The domain point: **a REIT scored like an operating company looks like a
disaster when nothing is wrong.** Depreciation on property that is typically
holding or gaining value pushes reported earnings far below the cash produced,
so EPS, P/E and an earnings-based payout ratio all misread. Realty Income pays
out roughly 250% of EPS and is perfectly sound.

| | REIT basis | Standard basis |
|---|---|---|
| Earnings | FFO (net income + D&A) | Net income / EPS |
| Valuation | P/FFO | P/E |
| Payout denominator | operating cash flow | free cash flow |
| Interest coverage | EBITDA ÷ interest | EBIT ÷ interest |
| Leverage band | 4.5–8× net debt/EBITDA | 1–4.5× |

Using EBIT for a REIT's coverage charges it for a non-cash cost it never funds
and roughly halves the apparent figure: Realty Income reads 2.0× on EBIT and
4.3× on EBITDA.

The SQL model reproduces the original JavaScript scorer pillar-for-pillar — O
94/62/46/96/68, UNP 43/48/30/100/39 — which is how the rounding bug above got
caught. Thresholds are screening heuristics, not a validated model, and every
input is exposed so a reader can disagree with the grade.

---

## Running it

```bash
npm install                                  # duckdb client for the serving layer
python -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt

npm run universe                             # refresh + validate the S&P 500 list
npm run extract:full                         # cold start: ~6 years x 503 symbols (~25 min)
npm run warehouse                            # dbt build + test
npm start                                    # http://127.0.0.1:5173
```

Thereafter `npm run pipeline` is incremental — prices from each symbol's
watermark, statements and dividends only once their staleness window expires, so
a nightly run costs ~500 rows (about 20KB gzipped) rather than a full
re-download.

The landing zone is gzipped: the S&P 500 at six years of daily bars is ~230MB of
JSON and ~30MB on disk. DuckDB decompresses `.jsonl.gz` transparently, and one
glob (`price__*.jsonl*`) covers both forms, so the compression is invisible to
every model.

On Windows the venv binaries are at `.venv/Scripts/` instead of `.venv/bin/`.

**Stop the server before rebuilding locally.** DuckDB allows a single writer,
and the server holding the file read-only blocks `dbt build` from taking the
lock. In production the two never overlap — CI builds the warehouse, then the
container restarts against the new file — but locally you need `npm start` down
while the pipeline runs.

The app degrades rather than fails if the warehouse is missing: `lib/warehouse.js`
opens it read-only and returns empty on absence, so a fresh clone still serves
the live-data dashboard, just without the screener.

### Swapping DuckDB for Postgres

`warehouse/profiles.yml`, and nothing else. The models are plain SQL; only the
`stg_*` layer uses DuckDB-specific `read_json_auto` to read the landing zone.
DuckDB is the default because it needs no service, so CI and a fresh clone both
work with zero setup.

---

## The dashboard

Served from the marts, with the live Yahoo path retained for symbols outside the
tracked universe.

**Screener** — all 82 tracked securities ranked by score, sortable on any column,
filterable by sector and by scoring basis. REIT rows show P/FFO and operating
companies show P/E in the same column, since that is the comparable measure for
each.

**Watchlists** — as many named lists as you like. **Wallets** — portfolios with
share counts and optional cost basis, showing value over time, day change, gain
against cost and per-position weight.

**Per-security view** — price chart (1D–MAX, crosshair, table view), then three
tabs: key statistics as one dense card, financials (revenue/net income,
dividends per share, full income statement), and the quality score with every
pillar input expanded.

Charts are hand-rolled SVG with no chart library, on a palette validated for
colourblind separation and contrast in both themes. Direction is always carried
by an arrow and a signed number as well as colour, every chart has a table-view
twin, and hit targets are the band rather than the painted mark.

---

## Deploying

Stateless, so `HOST=0.0.0.0 PORT=8080 node server.js` anywhere. A `Dockerfile` is
included; `GET /api/health` reports uptime, cache and warehouse freshness without
touching any upstream.

Caveats that actually bite:

- **Run one instance.** The request cache is in-process, so replicas multiply
  upstream traffic for the live-data path.
- **No authentication.** Anyone with the URL can spend your Yahoo quota.
- **Watchlists and wallets live in each visitor's `localStorage`** — no database,
  but equally no sync across devices.
- **Yahoo's terms do not permit redistributing their data.** Running this for
  yourself is one thing; publishing it as a service is a different question.

---

## Limits

- Yahoo serves roughly four to five years of statements, so growth rates are
  computed over that window.
- FFO is estimated as net income + D&A. True NAREIT FFO also strips gains on
  property sales and adds back impairments, which Yahoo does not report, so a
  REIT that sold heavily in a year will score with an inflated FFO.
- The wallet value chart holds share counts at what you hold *today* — it is a
  basket valuation, not a transaction-ledger replay.
- These are undocumented endpoints. They are stable in practice but can change
  without notice; the tests are the tripwire.
- For research and education. Not investment advice.
