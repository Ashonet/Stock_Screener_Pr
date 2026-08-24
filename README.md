# Stock analytics platform

[![ci](https://github.com/Ashonet/Stock_Screener_Pr/actions/workflows/ci.yml/badge.svg)](https://github.com/Ashonet/Stock_Screener_Pr/actions/workflows/ci.yml)
[![pipeline](https://github.com/Ashonet/Stock_Screener_Pr/actions/workflows/pipeline.yml/badge.svg)](https://github.com/Ashonet/Stock_Screener_Pr/actions/workflows/pipeline.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

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
        └─ dbt test     50 assertions · 8 of them written from real bugs
                              │
                    warehouse.duckdb (derived, gitignored)
                              │
              Node server reads the marts, no upstream calls at request time
```

Tracks **5,466 companies**: the full S&P 500 (503, the index carries dual share
classes), every common stock listed on the **Nasdaq** (4,328), and the
**Russell 2000** (1,986). 1,351 of them sit in more than one, and
`dim_index_membership` keeps a separate spell per index rather than collapsing
them.

### Two tiers, because the tail is not free

The S&P 500 costs about 29MB of committed raw and twenty-five minutes to
backfill. Five and a half thousand names at the same treatment is roughly
350MB in git, nine million price rows and five hours against an upstream that
rate-limits by IP, against a nightly budget of sixty minutes. So membership
decides how much of a symbol is fetched:

| Tier | Members | Fetched | History |
|---|---|---|---|
| deep | S&P 500, 503 | prices, financials, dividends, profile | 6 years |
| wide | Nasdaq and Russell 2000, 4,963 | prices only | 2 years |

The scorer needs statements, so only the deep tier is graded and appears in the
screener. The wide tier can be charted, searched and measured for return, which
is what it claims to support and no more. Either tier is selectable with
`--tier`, and `--deep all` will happily fetch everything at the cost above.

The nightly job runs the deep tier and a separate weekly job runs the wide one,
because the tail does not move differently for being refreshed daily and would
not fit the window if it did.

Why batch rather than live: the upstream rate-limits by IP. A live proxy works
on a laptop and falls over on a shared host. Scoring 503 companies from four
years of statements each is a few thousand upstream calls; against the mart it
is one local query, which is what makes the screener possible at all.

### The constituent lists are fetched, never typed

The three sources are not equivalent and the code says so: the S&P 500 is a
curated index with a published constituent file, the Nasdaq list is every
common stock *listed on* an exchange rather than an index at all, and the
Russell 2000 has no free official list so it is read from a tracking fund's
disclosed holdings, which lags reconstitution and is an approximation rather
than the index.

`pipeline/build-universe.js` pulls them from published sources and then
**validates every ticker against Yahoo before admitting it**, because index
membership is not the same as data availability. Companies get renamed, and a
hand-written list rots silently into missing additions and dead tickers. Symbols
that fail to resolve are dropped and named in `universe.json` rather than
disappearing quietly. All 503 currently resolve.

---

## Data quality, and the bug behind each test

This is the part worth reading. Every assertion below exists because something
was silently wrong, and none of them were failing loudly. The numbers looked
plausible, which is what made them dangerous.

| Test | The bug it came from |
|---|---|
| `assert_dividend_record_not_truncated` | Yahoo caps the dividend event list at 168 entries on `range=max` and drops the **middle**. Coca-Cola returned 1962–2003, then 2026, with two decades missing behind a chart that looked fine. Fixed by requesting an explicit period window; the test now watches for the cap fingerprint rather than for gaps (see below). |
| `assert_ebitda_present_with_revenue` | The extractor lower-cased only the first character of Yahoo's metric names, so `annualEBITDA` became `eBITDA`. It resolved to null on **every company**, blanking net-debt/EBITDA, interest coverage and EBITDA margin. Nothing errored; the balance-sheet pillar just quietly scored on one input instead of three. |
| `assert_no_phantom_dividend_cut` | Dividend growth was measured on calendar-year totals, which misreads every monthly payer: whether a distribution lands on 31 Dec or 1 Jan swings the year by a whole payment. Realty Income's 2024 calendar total sits 6% below 2023 *while it was raising throughout*. Fixed by bucketing on payment count (`int_dividend_windows`). |
| `assert_payout_ratio_sane` | The payout ratio came from a single reported year. Coca-Cola's 2025 free cash flow was held down by a one-off multi-billion tax deposit, printing a 166% payout on a well-covered dividend. Now averaged over three years. |
| `assert_grade_matches_score` | The letter grade was derived from the unrounded score while the card displayed the rounded one, so they disagreed at every boundary: 72.6 printed as "73" and graded as B, where the published ladder says 73 is a B+. |
| `assert_reit_affo_proxy_still_needed` | Records why AFFO is approximated by operating cash flow, and fails if the reason stops holding. |
| `assert_prices_are_fresh` | A pipeline that silently stops is worse than one that fails, because the dashboard keeps serving stale prices as current. |
| `assert_missed_splits_are_corrected` | Yahoo published Monster's 2:1 split of 11 August 2026 in its own events feed and left `adjclose` stepping down with the raw close instead of correcting for it. The stored series carried a permanent 50% cliff and every return across it was halved: MNST read **-29%** over the year against **+47.7%** actual. The anomaly mart found it within minutes of being built. |
| `assert_knowledge_intervals_do_not_overlap` | Guards the bitemporal derivation, because an overlap would let an "as of" query return two different values for the same figure on the same date. |
| *(unit)* `quoteFromChart` | The same "+511,286% today" bug, found a second time in a second place. The wallet built its own fallback quote from `chart.previousClose`, which is the close before the **whole range**, so on MAX the holdings table read **+541,057%** for Microsoft: today against 1986. The fix already existed for the company view but lived in a private function the wallet could not reach, so it had been written twice and only fixed once. |

Three of those tests were themselves wrong on first contact with the full
universe, which is the honest part of the story:

- **The contiguity test was wrong twice, and then deleted.** First it flagged
  T-Mobile, which paid one special dividend in 2013 and nothing until 2023.
  Narrowing it to "was a regular payer either side" survived 82 symbols and then
  produced **44 false positives** across the S&P 500. Every one was a real
  suspension: the 2008 crisis (AIG, Citigroup, Carnival, Freeport), COVID
  (Delta, Southwest, Marriott, Expedia, Disney), PG&E's bankruptcy, HCA's LBO.
  Suspensions are ordinary and suspending companies were regular payers on both
  sides, so gap *shape* cannot separate them from truncation. It was replaced by
  a test for the actual failure signature: a record pinned to exactly the
  168-entry cap with history missing from the middle.
- **Payment cadence was rounded to an arbitrary integer.** Nothing pays 5 or 11
  times a year, but Delta (suspended, then resumed unevenly) implied 4.68 and
  Healthpeak (quarterly → monthly in 2025) implied 11.4. Cadence now snaps to
  the set companies actually use: 1, 2, 4, 6 or 12.
- **The EBITDA test flagged five banks.** EBITDA is not meaningful for them:
  interest is revenue, not a financing cost to add back. Financials are
  therefore exempt, since otherwise a real regression would be buried under
  expected nulls.
- **"Yahoo reports no capex for REITs" turned out to be false.** It was inferred
  from two tickers. Across the universe, 9 of 13 REITs do report capex. The AFFO
  proxy is still applied uniformly, because mixing a true AFFO for some REITs
  with a proxy for others would make the payout column incomparable, and a
  screener that is not comparable is worthless. But the claim in the code and
  docs was wrong, and is now corrected.

### Three things this found that nothing else would have

**A split the upstream never applied.** `mart_price_anomalies` flags days that
sit far outside a symbol's own trailing volatility, and the first run put
Monster Beverage's 11 August 2026 close beside its previous one: 90.36 to 45.53,
volume doubled, adjusted close stepping down with the raw price rather than
correcting for it.

The first diagnosis was wrong. It looked like the incremental extract's
seven-day overlap being too short to catch a split, which rewrites every prior
bar upstream. Re-fetching the entire history changed nothing, because Yahoo
reports the 2:1 in its events feed *and* leaves `adjclose` unadjusted across it.
The upstream number is simply wrong. So splits are now captured as their own
entity, `int_split_corrections` works out which ones the upstream ignored, and
`fct_prices` applies the ratio itself. MNST went from -29% to +47.7% over the
year, and 1,501 bars were restated.

**A test that flagged a bad quarter as a corporate action.** The first version
looked for the shape of a split, a one-day move landing on a share ratio. It
caught The Trade Desk falling 33% on results, which is close enough to three for
two to match and is no such thing. Shape is not proof, and this project has
made that mistake before with dividend contiguity. The shape test is now a
warning that can reach symbols whose split events were never captured, and the
error-severity test reasons from the published event instead.

**A correction that broke what it was fixing.** The detector's first cut asked
whether the raw and adjusted closes moved together, which is true of every
*correctly* handled split, because Yahoo adjusts the raw close too. It flagged
Monster's 2023 split as missed and doubled three years of prior prices. What
marks a missed split is the raw close stepping by the ratio itself.

Running `dbt build` gives **73 pass, 3 warn** across the universe. The warnings
are 8 companies above 200% FCF payout (real, heavy capex cycles) and 25
periods missing EBITDA (healthcare and utilities where Yahoo does not model it). A warning that stays on deliberately is more useful than one
tuned until it disappears.

---

## Survivorship bias, and how it is kept out

The constituent file holds **today's** members. Six years of history for "the
S&P 500" built on that would silently exclude every company removed from the
index, and removals skew heavily toward failures, delistings and takeunders.
Any backtest over it reports the *survivors'* returns and calls them the index's.
It is the most common way a finance dataset lies to you, and the first version of
this warehouse had it.

`build-universe.js` therefore appends a full membership observation on every run
instead of overwriting, and `dim_index_membership` folds those observations into
`valid_from` / `valid_to` intervals: a Type 2 slowly-changing dimension. Index
membership at any past date is then reconstructable:

```sql
select symbol
from dim_index_membership
where date '2026-03-01' between valid_from and coalesce(valid_to, date '9999-12-31')
```

`assert_membership_spells_do_not_overlap` guards the derivation, because
gaps-and-islands logic is exactly the sort that quietly produces overlapping
spells and double-counts members.

## Point in time: what was true against what we knew

The warehouse is otherwise unitemporal. It stores what is true for a period and
replaces it silently when the upstream restates, which is right for a screener
and wrong for anything historical: a grade computed for FY2023 from statements
as they read today is not the grade anyone could have seen in 2023. The score
history documents that caveat; `fct_financial_knowledge` is what would let it be
removed.

Two time axes. `period_end` is when a figure was true of, `known_from` and
`known_to` are when we held that version of it, so a question with a date in it
has an answer:

```sql
select value from fct_financial_knowledge
where symbol = 'AAPL' and metric = 'totalRevenue' and period_end = '2024-09-30'
  and date '2025-03-01' >= known_from
  and (known_to is null or date '2025-03-01' < known_to)
```

A new interval opens only when the value changes. The extract re-fetches
statements on a staleness window, so an unchanged figure is observed dozens of
times, and opening an interval per observation would turn a table of
restatements into a table of pipeline runs.

`mart_restatements` reads the versions and reports what moved after first
publication. It holds **nothing today**, because the pipeline is days old and
the upstream has not revised anything yet. Like the membership history, it
accumulates from here and cannot recover what was reported before it existed.
That the raw layer already held every version and only the staging step discarded
them is what made this possible at all.

The history is thin today. It starts accumulating from the first run, and no
amount of cleverness can recover membership from before the pipeline existed.
Being explicit about that is the point: the bias is bounded and visible rather
than invisible and unbounded.

## Score history: why a warehouse at all

`mart_quality_score` is recomputed nightly, and a post-hook appends each day's
scores back into the landing zone. `fct_score_history` reads them, and
`mart_score_movers` ranks the largest changes since the previous run.

This is the clearest answer to *"why not just call the API?"* A live API can
tell you what a company looks like now. It cannot tell you what **changed**,
because nobody stored yesterday.

History lives in the append-only raw layer rather than in a dbt snapshot for a
specific reason: snapshots need a target that survives between runs, and this
warehouse is derived, gitignored and rebuilt from raw on every build, so a
snapshot table would reset to empty each time. Writing the day's scores back into
raw keeps history durable under the same rules as every other source, and it
survives `--full-refresh`.

---

## The warehouse

| Model | Grain | Notes |
|---|---|---|
| `stg_*` | raw | `read_json_auto` over the landing zone, reading `.jsonl` and `.jsonl.gz` through one glob. Every numeric goes through `try_cast`, because Yahoo signals "no value" with an empty object (`market_cap: {}` for Salesforce), and a direct cast fails the whole build on one bad cell. |
| `dim_security` | symbol | Defines `is_reit` once. Every downstream branch reads it rather than re-deriving. |
| `fct_prices` | symbol × date | **Incremental**, merged on the key. The extract deliberately re-fetches a week of overlap so Yahoo's restatements land and correct in place rather than duplicating. |
| `fct_financials` | symbol × period | Pivoted from long form. Statement coverage varies by industry (a railway reports no R&D), so raw stays long and widening happens here. |
| `fct_dividends` | symbol × pay date | Infers payment cadence from the **median gap over recent payments**. Agree Realty moved from quarterly to monthly in 2021; a median across its full record infers 11 payments a year, which is neither. |
| `int_dividend_windows` | symbol × window | Trailing totals bucketed by payment count, not calendar year. The model that fixes the monthly-payer bug. |
| `mart_quality_score` | symbol | The scoring model. Serving contract for the dashboard and screener. |
| `fct_financial_knowledge` | symbol × period × metric × version | Bitemporal. What each figure was, and the window during which we believed it. |
| `mart_price_anomalies` | symbol × date | Days beyond eight sigma of the symbol's own trailing volatility. Monitoring rather than assertion: the fifty tests encode rules someone thought of in advance, and this covers the value that breaks no rule and is still wrong. |

### The scoring model, and why REITs branch

`mart_quality_score` grades five pillars (dividend safety 25%, balance sheet
25%, growth 20%, profitability 15%, valuation 15%) into a 0-100 score and a
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

The SQL model reproduces the original JavaScript scorer pillar-for-pillar (O
94/62/46/96/68, UNP 43/48/30/100/39), which is how the rounding bug above got
caught.

### Score history

Under the live score, each past reporting period is graded and shown with the
return earned over it, by fiscal year or by quarter.

These are **recomputed, not recorded**. One score snapshot exists, from the
first pipeline run, so a real recorded history will not exist for years. The
question answered instead is *given the numbers this company reported for
FY2023, how would it have graded?* Restatements since are therefore included,
and it is not what the screener would have printed at the time. Three things
keep it honest:

- **Every period is scored the same way, including the latest.** The live score
  uses Yahoo's own trailing P/E, dividend yield and return on equity; none are
  available dated, so the series derives them from the statements and the price.
  Rather than mix the two, the series computes its own latest point, so the rows
  are comparable to each other.
- **Quarters are graded on trailing twelve months.** The scorer reasons in years
  throughout (three-year average payout, five-year CAGR), so a single quarter
  would compare a quarter's revenue against a year's and call it growth. Flows
  are summed across four quarters and balances taken at the close, because
  summing a balance sheet would report four times the debt. Where four quarters
  are not available, and Yahoo keeps only about five so the earliest never have
  four behind them, the average quarter is scaled back up to a year rather than
  leaving the period blank. That is what makes a partial window usable and also
  what makes it approximate: annualising one quarter assumes the other three
  look like it, which is wrong for any seasonal business. The count behind each
  row is shown.
- **Periods graded on thin history are marked.** The earliest row has the least
  behind it: with one year of statements there is no revenue or EPS trend, so
  its growth pillar rests on the dividend record alone and renormalises to a
  weight it has not earned. Realty Income reads A in FY2022 and B+ in FY2025 for
  partly that reason, and the marker says so rather than letting it read as
  decline. Thresholds are screening heuristics, not a validated model, and every
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

Thereafter `npm run pipeline` is incremental: prices from each symbol's
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
lock. In production the two never overlap (CI builds the warehouse, then the
container restarts against the new file), but locally you need `npm start` down
while the pipeline runs.

The app degrades rather than fails if the warehouse is missing: `lib/warehouse.js`
opens it read-only and returns empty on absence, so a fresh clone still serves
the live-data dashboard, just without the screener.

### Tests and CI

```bash
npm test          # 155 unit tests, no network, no database
npm run warehouse # 50 dbt assertions against the committed raw layer
npm run docs      # self-contained lineage site at warehouse/target/static_index.html
```

Three workflows:

| Workflow | Trigger | Does |
|---|---|---|
| `ci` | every push and PR | unit tests, then a full `dbt build` against the committed raw layer |
| `pipeline` | nightly, 22:30 UTC weekdays | incremental extract, rebuild, commit the new slice |
| `docs` | push to main | publishes the dbt lineage site to GitHub Pages |

`ci` deliberately makes **no upstream calls**. The committed landing zone is
enough to build and test the entire warehouse, so the checks are fast,
deterministic, and cannot be broken by a rate limit or a Yahoo outage.

The unit tests target the functions where bugs actually occurred: series
alignment across holdings with different histories, partial cost-basis coverage,
the REIT branch, the day-change fallback, treemap geometry, dividend
eligibility boundaries, and the grade-matches-score invariant. They do not sweep
the API for coverage's sake.

The most recent one they caught: `Number(null)` is `0`, not `NaN`, so testing a
cost basis *after* conversion read "no cost basis given" as "bought at zero",
and every holding saved without one came back at `$0.00` on the next load and
reported the entire position as gain. Absence is now checked before conversion,
in both the parser and the browser store.

### Swapping DuckDB for Postgres

`warehouse/profiles.yml`, and nothing else. The models are plain SQL; only the
`stg_*` layer uses DuckDB-specific `read_json_auto` to read the landing zone.
DuckDB is the default because it needs no service, so CI and a fresh clone both
work with zero setup.

---

## The dashboard

### The warehouse is also the fallback

The screener reads the marts. The per-security view prefers live Yahoo, which
has richer coverage and real-time prices, but **falls back to stored data when
the session-gated endpoints are rate-limited**, which on a shared host is routine
rather than exceptional.

`securityBundle()` reshapes warehouse rows into Yahoo's own module layout, so
`buildProfile` and `buildScore` consume it unchanged. That matters: a stored
security is graded by exactly the same code as a live one, and the score comes
out identical rather than merely similar. Each piece falls back independently, so
a live statement set is still used even when the profile call failed.

Stored data is labelled with its date rather than passed off as current, and a
a symbol outside the tracked universe still degrades honestly: there is nothing
stored to serve, and saying so beats inventing it.

**Screener**: all 505 tracked securities ranked by score, sortable on any
column, filterable by sector and by scoring basis. REIT rows show P/FFO and operating
companies show P/E in the same column, since that is the comparable measure for
each.

A **demo portfolio** appears alongside your own wallets, because every tab in the
wallet view needs holdings to say anything and half of them need purchase dates
as well. Ten companies across seven sectors, grades from A+ to D, two REITs,
and yields from 0.7% to 6.8%, bought on staggered dates so the value series
steps and the score line moves for reasons other than price. The cost bases are
the actual closes on those dates, so it is up about half overall with JPM and
CAT carrying it while VICI and PG are down: a demo where everything wins
teaches the reader to distrust the rest of the page. Deleting it is recorded
and keeps it deleted, since absence and deletion look identical in storage and
mean opposite things.

**Watchlists**: as many named lists as you like. **Wallets**: portfolios with
share counts, optional cost basis and optional purchase date, showing value over
time, day change, gain against cost and per-position weight.

**Dividend income**: what a wallet has actually been paid, as a month-by-month
chart, a per-holding summary and a full payment ledger. Two things make the
numbers honest rather than approximately right:

- **Eligibility is decided on the ex-dividend date, strictly after the purchase
  date.** Yahoo's dividend events are ex-dates, not pay dates, and the buyer on
  an ex-date does not receive that distribution. Counting it would overstate the
  first year of every position, so the boundary is `>`, not `>=`.
- **A holding with no purchase date is excluded and named,** rather than assumed
  to have been held forever. The share count is today's applied back to the
  purchase date, which overstates a position that was topped up; the card says
  so instead of presenting the total as settled fact.

**Income forecast**: each holding's trailing twelve months of dividends grown
forward at its own five-year dividend CAGR, taken from the same
`trailingYearTotals` and `cagr` the quality score uses so a holding cannot
report one growth rate in the score panel and a different one in the forecast.
The portfolio rate is blended by income paid rather than averaged across
holdings, so a tiny position cannot outvote the one that provides the income.

It is arithmetic on one assumption, and the assumption is the weak part: a
five-year CAGR describes the years a company chose to raise in, so it cannot
see a cut, and a cut is when an income forecast would matter most. Rates that
will not survive extrapolation are marked rather than capped, because capping
substitutes a different number without saying so. NVIDIA's dividend has grown
77% a year from almost nothing, which compounds $2.80 into $49 over five years;
the row carries a warning rather than a quietly adjusted figure.

**Breakdown**: what the wallet is made of, as a donut over holding, sector,
industry, quality grade, type (REIT against operating company) or country.
Concentration is the thing worth seeing and it hides well in a holdings table:
three positions can look diversified and turn out to be one sector.

Slices are named until the remainder is under a tenth of the chart, then
folded. Cutting at a fixed six instead made "Other" the story rather than the
remainder: a ten-holding wallet across ten industries folded five of them into
a single 32% wedge, the largest thing on the chart and the one saying the
least. A ceiling of sixteen still applies for the case where no amount of
slicing helps, and past the six palette hues the repeats are mixed toward the
surface and then the text so a colour is separable from the one it repeats.
The names inside "Other" are printed rather than left to trust.
Every slice carries its share on the ring, so the reading never depends on
matching a colour back to a legend, and the table twin holds the exact values,
because people compare angles badly.

**Quality over time**: the wallet's weighted quality score, and the holdings
behind it. Three separate things move that line and the model keeps them apart:
a company reporting a new year, a holding's weight drifting with its price, and
a holding joining on the day it was bought. The last is what makes it a
portfolio's score rather than a watchlist's average, since a wallet that held
one C-graded company and later bought three A-graded ones did not have a good
portfolio for that first year.

Weighted by position value throughout, because the score is what the money is
invested in and a $200 position should not outvote a $60,000 one. A holding
outside the scored universe is left out of the score rather than counted as
zero, and the share of value that carried a grade is reported beside it, since a
score resting on a third of the portfolio is a different claim from one resting
on all of it. The same weighted figure appears next to the wallet's value.

**Goal**: the income you want, and what the portfolio has to be worth to pay
it. A portfolio drawn at `w` percent supports `value x w` of income, so the
target needs `target / w` of capital, and the rate is a control rather than a
constant because it is the assumption doing all the work: at 3% a $30,000
income needs a million, at 4% it needs 750,000.

The part worth having is the split. **Dividends are not income on top of the
withdrawal, they are the part of it that arrives without selling.** A portfolio
yielding 1.2% drawn at 3% has to sell the other 1.8% every year; one yielding
3.3% sells nothing. Treating the yield as additional would tell someone they
need half the portfolio they actually do, so the tab reports the gap between
the rate and the yield at today's value and at the target, alongside the value
at which dividends alone would cover it.

It also answers what it takes to get there: a horizon of 1 to 50 years, and
the contribution per month and per year that closes the gap, solved from
`FV = PV(1+r)^n + PMT x ((1+r)^n - 1) / r`. The monthly figure is not the
yearly one over twelve, because twelve payments spread through the year
compound for longer than one at the end of it, so both are computed on their
own terms.

The plan is given twice, **with the dividends reinvested and with them taken
as cash**, because for anything with a real yield that choice is most of the
answer rather than a detail. This wallet grows 1.6% a year on price and yields
3.3%, so it compounds at 4.9% reinvested and at 1.6% spent, and over thirty
years that is $1,166 a month against $2,122. The difference, what not
reinvesting costs to arrive at the same place on the same date, is reported on
its own line.

The rate behind that is the wallet's own, and getting it honestly is the
interesting part. The plain change in value is not a return, because the
series steps up whenever a holding joins. So it is **chain-linked**: the
series is cut at every purchase, each stretch measured on its own, and the
pieces multiplied together, which leaves the contribution jumps outside the
product. On the wallet used while building this the raw change reads +353.8%
and the time-weighted return is 1.6% a year. Yield is added back for a total
return, since the value series is built from closes and has no dividends in
it. The rate can be overridden.

Growth since the first purchase is shown but **not annualised where holdings
were bought later**. The wallet's series starts with the first holding alone
and others join on their own dates, so the change from then to now is capital
added plus what it earned. Compounding that would print "42% a year" on a
wallet that went from 3,550 to 16,089 by buying more, and without a per-lot
ledger the two cannot be separated, so the rate is withheld rather than
published with a caveat nobody reads.

**Fundamentals**: a grid of statement trends that branches on the same basis
the scorer does. A REIT is charted on FFO, FFO per share, an AFFO range, payout
against that range and capital expenditure, and is not charted on EPS or net
income at all,
because depreciation on property that is holding its value pushes both far
below the cash produced and a chart of them shows a business in trouble when
nothing is wrong. An operating company gets earnings, EPS, book value per
share, margins and return on equity. Both get revenue, cash flow, leverage,
interest coverage and the share count, which is where a REIT's dilution and an
operating company's buybacks both show up.

**AFFO is drawn as a range rather than a figure.** True AFFO is FFO less
*recurring maintenance* capex, and the statement feed carries one capex line
covering maintenance and growth together. For a landlord that spends nothing
the distinction is immaterial: Realty Income and VICI report no capex line at
all and Welltower's is 1% of FFO. For a REIT that builds it decides the answer.
American Tower spends 37% of FFO on capex and Equinix spends 126%, so
subtracting the whole line gives Equinix a **negative AFFO**, which is not a
hard number so much as a wrong one. Both estimates are therefore drawn side by
side, FFO less capex against operating cash flow, and neither is called AFFO on
its own. Which reads higher is not fixed either: VICI's FFO less capex sits
above its operating cash flow because working capital moved against it.

The quality score keeps using operating cash flow alone for every REIT, because
its payout column is compared *between* REITs and a measure that changed
definition per company would make that column mean two things at once. These
charts compare a company against its own past, where a range beats a false
precision.

**Occupancy is not available, and the card says so.** Nor is same-store NOI,
releasing spread or weighted average lease term: they live in REIT
supplementals and earnings decks, not in the financial statements this is built
from. Inventing a proxy and calling it occupancy would be worse than the gap.

**Per-security view**: price chart (1D–MAX, crosshair, table view), then four
tabs: key statistics as one dense card, financials (revenue/net income,
dividends per share, full income statement), and the quality score with every
pillar input expanded.

**Compare**: several securities rebased to the same start date and the same
starting amount, with a toggle between total return and price only. The toggle
is the point of the view. A price chart says what a share did, not what owning
it did, and for anything with a yield those differ enough to invert the ranking:
over the window the warehouse currently holds, Realty Income is up 4% on price
and 40% with distributions, so **90% of its return is the dividend**, against
0.5% of NVIDIA's. `adjClose` is adjusted for splits and distributions and
`close` for splits only, so running both through the same rebasing gives the
split exactly, with no reinvestment model of ours to be wrong about.

### Does the score predict anything?

The Compare view's second tab answers the question the rest of the project
invites: split the same money evenly across every company holding a grade, hold
it, and see where each grade's portfolio ends up. Windows of 1, 3, 5, 10 and 20
years, mean and median side by side.

The grade used to form the portfolio is the whole methodology, so it is a
control rather than a default. **Grade known then** uses the grade each company
held when the window opened, which is a strategy that could have been run.
**Today's grades** applies current grades backwards, which is not a strategy and
cannot be: a company earns an A partly by having done well over the very period
being measured. The tab says so above the numbers rather than below them.

The finding so far is unflattering and is published as such. Over one year the
ladder inverts: D and F portfolios beat A+. Over five years on today's grades
the medians order roughly as intended (A+ +62.8%, F +20.3%) while the means do
not, because equal-weight means are carried by a few holdings, and one 39x
position lifts a sixty-stock basket by tens of points on its own. Both are
reported for exactly that reason: the mean is what the basket really earned and
the median is what its typical member did.

Six years of one market regime is not evidence about a scoring method, the
universe is today's index so departed companies are missing, and the low grades
are flattered most by that. All three are stated on the card.

**Market map**: the index as a squarified treemap, grouped by sector and sized
by market cap, shaded either by day change or by quality score. The layout is
the Bruls/Huizing/van Wijk algorithm in `public/js/treemap.js`, kept free of any
DOM or colour knowledge so it is unit-testable on geometry alone.

Charts are hand-rolled SVG with no chart library, on a palette validated for
colourblind separation and contrast in both themes, which follow the operating
system rather than an in-app switch. Direction is always carried
by an arrow and a signed number as well as colour, every chart has a table-view
twin, and hit targets are the band rather than the painted mark.

---

## Deploying

Stateless, so `HOST=0.0.0.0 PORT=8080 node server.js` anywhere. `GET /api/health`
reports uptime, cache and warehouse freshness without touching any upstream; use
it as the platform health check path.

The `Dockerfile` is two-stage. The warehouse is derived and not in git, but the
app serves from it, so stage one installs dbt and builds it from the committed
landing zone and stage two copies only the resulting file into a Node runtime.
That keeps an 84MB binary out of the repository while still giving the deployed
site a warehouse, and because it uses `dbt build` rather than `dbt run`, a
failing data test stops the image being produced at all.

Set `HOST=0.0.0.0` on any container platform. The default of `127.0.0.1` is
correct on a laptop and unreachable from outside a container, which produces a
deploy that builds cleanly and answers nothing.

Caveats that actually bite:

- **Run one instance.** The request cache is in-process, so replicas multiply
  upstream traffic for the live-data path.
- **No authentication.** Anyone with the URL can spend your Yahoo quota.
- **Watchlists and wallets live in each visitor's `localStorage`**: no database,
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
- The wallet value chart brings each holding in on its purchase date, so it
  never counts a position before it was bought, but share counts are today's
  throughout. Topping a position up therefore reads back through the whole
  period it was held. It remains a value series rather than a return series:
  the line steps up when a holding is added, and that step is money paid in.
- These are undocumented endpoints. They are stable in practice but can change
  without notice; the tests are the tripwire.
- For research and education. Not investment advice.

---

## Licence

MIT, see [LICENSE](LICENSE).

That covers the code. It does not cover the market data the pipeline retrieves,
which belongs to its providers and is subject to their terms. The committed
landing zone is there to make the build and its tests reproducible without
network access, not to publish a dataset.
