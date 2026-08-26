{{ config(post_hook="{{ export_score_history() }}") }}

-- Five-pillar quality score, REIT-aware.
--
-- This is the JavaScript scorer (lib/score.js) expressed as a data model: same
-- pillars, weights and thresholds, but versioned, testable and queryable rather
-- than computed per request in application code.
--
-- The whole point is the branch on `is_reit`. Scored like an operating company,
-- a REIT looks like a disaster when nothing is wrong: depreciation on property
-- that is typically holding or gaining value pushes reported earnings far below
-- the cash the business produces, so EPS, P/E and an earnings-based payout
-- ratio all misread. Realty Income pays out roughly 250% of EPS and is sound.
-- So the REIT branch swaps in FFO for earnings, P/FFO for P/E, operating cash
-- flow for free cash flow as the payout denominator, EBITDA for EBIT in
-- interest coverage, and a leverage band appropriate to property.
--
-- Thresholds are screening heuristics, not a validated model.

with security as (

    select * from {{ ref('dim_security') }}

),

annual as (

    select * from {{ ref('fct_financials') }}
    where period_type = 'annual'

),

latest as (

    select * from annual where recency_rank = 1

),

-- ------------------------------------------------------- valuation in context
--
-- An absolute P/E band cannot be right for everything it is applied to. Scoring
-- every company against a fixed 12-to-35 scale says a utility on 22 and a
-- software company on 22 are equally priced, which is not a claim anyone
-- familiar with either would make. So the same multiple is read two further
-- ways: against the company's own past, and against its peers.
--
-- The two catch different errors. Against its own history is the comparison
-- least contaminated by sector fashion, because the business is its own
-- control. Against its peers is the one that sees a whole industry rerating,
-- which the history comparison cannot: if an industry doubled its multiple over
-- five years, every member looks fair against its own past and the group may
-- still be expensive. The absolute band survives at reduced weight because it
-- is the only one of the three that can see a bubble lifting company and
-- industry together.

-- Earnings paired with the date they could first have been acted on.
--
-- The 90 days is an assumption, stated rather than measured. US annual reports
-- are due 60 to 90 days after the fiscal year ends. `fct_financial_knowledge`
-- would be the right source, but it records when this pipeline first ingested a
-- figure, which for a warehouse built in 2026 is 2026 for every row including
-- the 2021 ones. Using period_end itself would credit the series with knowing
-- FY2024 earnings on the last day of FY2024, months before anyone could have.
--
-- REITs are priced on FFO per share, not EPS, for the same reason the rest of
-- this model branches on is_reit: depreciation on property that is typically
-- holding its value pushes reported earnings far below the cash produced, so a
-- REIT P/E is not a valuation anyone uses. Realty Income prints a P/E near 50
-- and a P/FFO near 15, and only the second is comparable to anything.
reportable_earnings as (

    select
        a.symbol,
        a.period_end,
        case
            when d.is_reit then a.ffo / nullif(a.dilutedaverageshares, 0)
            else a.dilutedeps
        end as eps,
        a.period_end + interval 90 day as known_from
    from annual a
    join security d on d.symbol = a.symbol
    where case
              when d.is_reit then a.ffo / nullif(a.dilutedaverageshares, 0)
              else a.dilutedeps
          end is not null

),

-- One observation a month. A daily series is 250 points a year saying what
-- twelve already say, at 250 times the width.
month_end as (

    select symbol, max(trade_date) as trade_date
    from {{ ref('fct_prices') }}
    group by symbol, date_trunc('month', trade_date)

),

-- Raw close, deliberately, not adj_close.
--
-- adj_close is restated into today's share basis, and earnings per share are
-- reported in the share basis of their own year. Pairing an adjusted price with
-- an unadjusted EPS halves the multiple across any split: Monster's 2025 split
-- would print every pre-split year at half its true P/E, manufacturing a
-- company that looks to have doubled in expensiveness when nothing happened.
month_end_price as (

    select p.symbol, p.trade_date, p.close
    from {{ ref('fct_prices') }} p
    join month_end m
      on m.symbol = p.symbol
     and m.trade_date = p.trade_date

),

-- The multiple as it stood each month, on the earnings then public: P/E for an
-- operating company, P/FFO for a REIT. An asof join is exactly this question,
-- the most recent report at or before this date.
multiple_history as (

    select
        p.symbol,
        p.trade_date,
        p.close / e.eps as multiple
    from month_end_price p
    asof join reportable_earnings e
      on p.symbol = e.symbol
     and p.trade_date >= e.known_from
    where e.eps > 0

),

-- A negative multiple is not cheap and a 5,000x multiple is not expensive; the
-- first is a loss-maker and the second is a company earning a cent a share.
-- Both are arithmetic rather than valuation, and both would sort straight to
-- the top or bottom of any ranking built on this.
usable_multiples as (

    select * from multiple_history
    where multiple > 0 and multiple <= 200

),

own_history as (

    select
        symbol,
        median(multiple) as history_median_multiple,
        count(*) as history_observations
    from usable_multiples
    group by symbol
    having count(*) >= 24

),

-- Current is built on the same earnings basis as the series rather than on the
-- vendor's trailing P/E, so the ratios below divide like by like: a vendor TTM
-- multiple over a median built from annual EPS is two measures in one fraction.
--
-- The price, though, is the latest close rather than the last month-end. The
-- question "is it expensive today" wants today's price, and the month-end
-- series exists only to give that number something to be compared against.
-- lib/warehouse.js builds the peer pool the same way, so the two scorers agree.
current_multiple as (

    select
        l.symbol,
        l.close / e.eps as current_multiple
    from (
        select symbol, close, trade_date
        from (
            select symbol, close, trade_date,
                   row_number() over (partition by symbol order by trade_date desc) as rn
            from {{ ref('fct_prices') }}
        )
        where rn = 1
    ) l
    asof join reportable_earnings e
      on l.symbol = e.symbol
     and l.trade_date >= e.known_from
    where e.eps > 0
      and l.close / e.eps > 0
      and l.close / e.eps <= 200

),

peer_pool as (

    select
        c.symbol,
        c.current_multiple as multiple,
        d.industry,
        d.sector,
        d.is_reit
    from current_multiple c
    join security d using (symbol)

),

-- Peer medians exclude the company itself. Including it drags the very number
-- it is then measured against, which flatters a large member of a small group.
--
-- An unknown is_reit is read as an operating company rather than as its own
-- third category, which is what `is not distinct from` would have made it:
-- a handful of securities would then have been comparable only to other
-- securities of unknown type. lib/valuation.js coerces the same way.
--
-- REITs are held apart from operating companies at every grouping. Depreciation
-- on property that is not losing value pushes REIT earnings far below the cash
-- produced, so REIT P/Es sit structurally higher and the comparison is
-- meaningless in either direction.
industry_peers as (

    select
        a.symbol,
        median(b.multiple) as peer_median,
        count(*) as peer_count
    from peer_pool a
    join peer_pool b
      on b.symbol <> a.symbol
     and coalesce(b.is_reit, false) = coalesce(a.is_reit, false)
     and b.industry is not distinct from a.industry
    where a.industry is not null
    group by a.symbol
    having count(*) >= 5

),

-- The fallback exists because Yahoo's industry taxonomy is finer than this
-- universe is wide: 69 of 111 industries hold fewer than five scored companies.
-- A median of two is not a peer comparison, so a group that thin widens to the
-- sector, and `peer_basis` below reports that it did.
sector_peers as (

    select
        a.symbol,
        median(b.multiple) as peer_median,
        count(*) as peer_count
    from peer_pool a
    join peer_pool b
      on b.symbol <> a.symbol
     and coalesce(b.is_reit, false) = coalesce(a.is_reit, false)
     and b.sector is not distinct from a.sector
    where a.sector is not null
    group by a.symbol
    having count(*) >= 5

),

peer_comparison as (

    select
        p.symbol,
        coalesce(i.peer_median, sp.peer_median) as peer_median_multiple,
        coalesce(i.peer_count, sp.peer_count) as peer_count,
        case
            when i.peer_median is not null then 'industry'
            when sp.peer_median is not null then 'sector'
        end as peer_basis
    from peer_pool p
    left join industry_peers i on i.symbol = p.symbol
    left join sector_peers sp on sp.symbol = p.symbol

),

-- Payout averaged over three reported years. One year is too jumpy to grade
-- on: Coca-Cola's 2025 free cash flow was held down by a one-off multi-billion
-- tax deposit, which alone prints a 166% payout on a well-covered dividend.
payout as (

    select
        a.symbol,
        count(*) as years_used,
        sum(abs(a.cashdividendspaid)) as dividends_paid,
        sum(case when s.is_reit then a.operatingcashflow else a.freecashflow end) as distributable_cash
    from annual a
    join security s using (symbol)
    where a.recency_rank <= 3
      and a.cashdividendspaid is not null
      and (case when s.is_reit then a.operatingcashflow else a.freecashflow end) is not null
    group by a.symbol

),

-- Growth over the reported window, oldest to newest.
growth as (

    select
        symbol,
        max(case when recency_rank = 1 then totalrevenue end) as revenue_new,
        max(case when recency_rank = least(5, max_rank) then totalrevenue end) as revenue_old,
        max(case when recency_rank = 1 then dilutedeps end) as eps_new,
        max(case when recency_rank = least(5, max_rank) then dilutedeps end) as eps_old,
        max(case when recency_rank = 1 then ffo / nullif(dilutedaverageshares, 0) end) as ffops_new,
        max(case when recency_rank = least(5, max_rank) then ffo / nullif(dilutedaverageshares, 0) end) as ffops_old,
        max(least(5, max_rank)) - 1 as growth_years
    from (
        select a.*, max(recency_rank) over (partition by symbol) as max_rank
        from annual a
    )
    group by symbol

),

-- Dividend record, measured on payment-count windows (see int_dividend_windows).
dividend_windows as (

    select
        symbol,
        max(case when window_index = 0 then amount end) as latest_year_amount,
        max(case when window_index = least(5, max_window) then amount end) as older_year_amount,
        max(least(5, max_window)) as dividend_years,
        max(max_window) as windows_observed
    from (
        select w.*, max(window_index) over (partition by symbol) as max_window
        from {{ ref('int_dividend_windows') }} w
    )
    group by symbol

),

-- Consecutive rising windows, counted back from the most recent.
streaks as (

    select
        symbol,
        -- The first window that failed to rise ends the streak; if none failed,
        -- the streak runs the whole observed history.
        coalesce(min(case when not rose then window_index end), max(window_index)) as raise_streak,
        max(window_index) as windows_compared
    from (
        select
            symbol,
            window_index,
            amount > lead(amount) over (partition by symbol order by window_index) * 1.001 as rose
        from {{ ref('int_dividend_windows') }}
    )
    where rose is not null
    group by symbol

),

base as (

    select
        s.symbol,
        s.name,
        s.sector,
        s.industry,
        s.is_reit,
        s.market_cap,
        s.currency,

        l.period_end as fiscal_year_end,
        l.ffo,
        l.netincome,
        l.totalrevenue,
        l.dilutedeps,
        l.freecashflow,
        l.operatingcashflow,
        l.ebitda_margin_pct,
        l.operating_margin_pct,
        s.return_on_equity_pct,

        -- Valuation. P/FFO is computed from market cap rather than per-share so
        -- a share-count timing mismatch cannot distort it.
        case when l.ffo > 0 then s.market_cap / l.ffo end as price_to_ffo,
        s.trailing_pe,

        -- Valuation in context. The ratios are formed in `flagged` below, once
        -- these are all in scope.
        cm.current_multiple,
        oh.history_median_multiple,
        oh.history_observations,
        pc.peer_median_multiple,
        pc.peer_count,
        pc.peer_basis,
        case when l.ffo is not null and l.dilutedaverageshares > 0
             then l.ffo / l.dilutedaverageshares end as ffo_per_share,

        -- Leverage.
        case when l.totaldebt is not null
             then l.totaldebt - coalesce(l.cashandcashequivalents, 0) end as net_debt,
        case when l.ebitda > 0 and l.totaldebt is not null
             then (l.totaldebt - coalesce(l.cashandcashequivalents, 0)) / l.ebitda end as net_debt_to_ebitda,
        -- Coverage is measured before depreciation for a REIT: charging it for
        -- a non-cash cost it never funds roughly halves apparent coverage
        -- (Realty Income reads 2.0x on EBIT and 4.3x on EBITDA).
        case when abs(l.interestexpense) > 0
             then (case when s.is_reit then l.ebitda else l.ebit end) / abs(l.interestexpense) end as interest_coverage,
        case when l.totalassets > 0 then l.totaldebt / l.totalassets end as debt_to_assets,

        case when l.totalrevenue > 0 then l.ffo / l.totalrevenue * 100 end as ffo_margin_pct,

        -- Income.
        case when p.distributable_cash > 0
             then p.dividends_paid / p.distributable_cash * 100 end as payout_pct,
        p.years_used as payout_years,
        s.dividend_yield_pct,
        s.five_year_avg_dividend_yield_pct,
        case when s.five_year_avg_dividend_yield_pct > 0
             then s.dividend_yield_pct / s.five_year_avg_dividend_yield_pct end as yield_vs_history,
        coalesce(st.raise_streak, 0) as raise_streak,
        coalesce(st.windows_compared, 0) as dividend_windows_observed,

        {{ cagr('g.revenue_old', 'g.revenue_new', 'g.growth_years') }} as revenue_cagr_pct,
        case
            when s.is_reit then {{ cagr('g.ffops_old', 'g.ffops_new', 'g.growth_years') }}
            else {{ cagr('g.eps_old', 'g.eps_new', 'g.growth_years') }}
        end as per_share_cagr_pct,
        {{ cagr('dw.older_year_amount', 'dw.latest_year_amount', 'dw.dividend_years') }} as dividend_cagr_pct,

        case when l.totalrevenue > 0 then l.freecashflow / nullif(s.market_cap, 0) * 100 end as fcf_yield_pct

    from security s
    join latest l using (symbol)
    left join current_multiple cm using (symbol)
    left join own_history oh using (symbol)
    left join peer_comparison pc using (symbol)
    left join payout p using (symbol)
    left join growth g using (symbol)
    left join dividend_windows dw using (symbol)
    left join streaks st using (symbol)

),

flagged as (

    select
        *,
        -- Is the dividend a real claim on cash flow, worth grading for safety?
        -- Apple yields 0.35% but pays out ~15% of free cash flow with a long
        -- raise record, so yes. NVIDIA's is a rounding error on both counts.
        coalesce(dividend_yield_pct > 0
                 and (dividend_yield_pct >= 0.25 or payout_pct >= 5), false) as pays_dividend,
        -- Is the yield large enough for "yield vs its own history" to mean
        -- anything? At 0.02% that ratio is noise.
        coalesce(dividend_yield_pct >= 1 and five_year_avg_dividend_yield_pct > 0, false) as yield_history_usable,

        -- Below 1 is cheaper than it has been, and cheaper than the group.
        -- Neither says the company is good: a multiple compresses precisely
        -- because the market expects earnings to shrink, and that value trap
        -- is indistinguishable from a bargain on this measure. The growth and
        -- profitability pillars are the only counterweight the model has.
        case when history_median_multiple > 0
             then current_multiple / history_median_multiple end as multiple_vs_history,
        case when peer_median_multiple > 0
             then current_multiple / peer_median_multiple end as multiple_vs_peers
    from base

),

scored as (

    select
        *,

        case when pays_dividend then
            {{ score_between('payout_pct', 'case when is_reit then 100 else 90 end', 'case when is_reit then 70 else 40 end') }}
        end as s_payout,
        case when pays_dividend then {{ score_between('raise_streak', 0, 10) }} end as s_streak,

        {{ score_between('net_debt_to_ebitda', 'case when is_reit then 8 else 4.5 end', 'case when is_reit then 4.5 else 1 end') }} as s_leverage,
        {{ score_between('interest_coverage', 'case when is_reit then 2 else 3 end', 'case when is_reit then 5.5 else 15 end') }} as s_coverage,
        {{ score_between('debt_to_assets', 'case when is_reit then 0.65 else 0.6 end', 'case when is_reit then 0.30 else 0.20 end') }} as s_debt_assets,

        {{ score_between('revenue_cagr_pct', 0, 12) }} as s_revenue_growth,
        {{ score_between('per_share_cagr_pct', 0, 10) }} as s_per_share_growth,
        case when pays_dividend then {{ score_between('dividend_cagr_pct', 0, 8) }} end as s_dividend_growth,

        case when is_reit then {{ score_between('ebitda_margin_pct', 40, 70) }}
             else {{ score_between('operating_margin_pct', 5, 30) }} end as s_margin,
        case when is_reit then {{ score_between('ffo_margin_pct', 30, 65) }}
             else {{ score_between('return_on_equity_pct', 5, 25) }} end as s_returns,

        case when is_reit then {{ score_between('price_to_ffo', 28, 13) }}
             else {{ score_between('trailing_pe', 35, 12) }} end as s_valuation_multiple,
        case when yield_history_usable then {{ score_between('yield_vs_history', 0.7, 1.3) }}
             else {{ score_between('fcf_yield_pct', 2, 8) }} end as s_valuation_yield,
        {{ score_between('multiple_vs_history', 1.3, 0.7) }} as s_valuation_history,
        {{ score_between('multiple_vs_peers', 1.3, 0.7) }} as s_valuation_peers

    from flagged

),

pillars as (

    select
        *,
        {{ weighted_score([['s_payout', 0.55], ['s_streak', 0.45]]) }} as pillar_dividend,
        {{ weighted_score([['s_leverage', 0.5], ['s_coverage', 0.3], ['s_debt_assets', 0.2]]) }} as pillar_balance_sheet,
        {{ weighted_score([['s_revenue_growth', 0.35], ['s_per_share_growth', 0.4], ['s_dividend_growth', 0.25]]) }} as pillar_growth,
        {{ weighted_score([['s_margin', 0.5], ['s_returns', 0.5]]) }} as pillar_profitability,
        -- The absolute multiple keeps a quarter of the weight rather than the
        -- 0.6 it held alone: it is the only component that can see company and
        -- industry inflate together, and the worst of the three at judging
        -- whether any one multiple is deserved. weighted_score renormalises
        -- over what is non-null, so a company without enough history or peers
        -- falls back toward the absolute reading rather than losing the pillar.
        {{ weighted_score([
            ['s_valuation_multiple', 0.25],
            ['s_valuation_history', 0.30],
            ['s_valuation_peers', 0.25],
            ['s_valuation_yield', 0.20]
        ]) }} as pillar_valuation
    from scored

),

overall as (

    select
        *,
        {{ weighted_score([
            ['pillar_dividend', 0.25],
            ['pillar_balance_sheet', 0.25],
            ['pillar_growth', 0.20],
            ['pillar_profitability', 0.15],
            ['pillar_valuation', 0.15]
        ]) }} as overall_score,

        -- Coverage: how much of the weighting actually had data behind it.
        (case when pillar_dividend      is not null then 0.25 else 0 end
       + case when pillar_balance_sheet is not null then 0.25 else 0 end
       + case when pillar_growth        is not null then 0.20 else 0 end
       + case when pillar_profitability is not null then 0.15 else 0 end
       + case when pillar_valuation     is not null then 0.15 else 0 end) * 100 as coverage_pct
    from pillars

),

graded as (

    select
        *,
        -- Round once, here, and grade off the rounded value.
        --
        -- Grading the raw score while displaying the rounded one makes the two
        -- disagree at every boundary: 72.6 prints as "73" and grades as B, so
        -- the card reads "73 · B" where the ladder says 73 is a B+. The letter
        -- must be derived from the number the reader is actually shown.
        -- `assert_grade_matches_score` enforces this.
        case when coverage_pct >= 40 then round(overall_score) end as final_score
    from overall

)

select
    symbol,
    name,
    sector,
    industry,
    is_reit,
    case when is_reit then 'reit' else 'standard' end as scoring_basis,
    fiscal_year_end,

    -- A score built on less than 40% of the weighting is not a score.
    final_score as overall_score,
    case
        when final_score is null then null
        when final_score >= 88 then 'A+'
        when final_score >= 80 then 'A'
        when final_score >= 73 then 'B+'
        when final_score >= 66 then 'B'
        when final_score >= 58 then 'C+'
        when final_score >= 50 then 'C'
        when final_score >= 40 then 'D'
        else 'F'
    end as grade,
    round(coverage_pct) as coverage_pct,

    round(pillar_dividend)      as pillar_dividend,
    round(pillar_balance_sheet) as pillar_balance_sheet,
    round(pillar_growth)        as pillar_growth,
    round(pillar_profitability) as pillar_profitability,
    round(pillar_valuation)     as pillar_valuation,

    -- The inputs, so a reader can disagree with the grade.
    pays_dividend,
    payout_pct,
    payout_years,
    raise_streak,
    dividend_windows_observed,
    net_debt_to_ebitda,
    interest_coverage,
    debt_to_assets,
    revenue_cagr_pct,
    per_share_cagr_pct,
    dividend_cagr_pct,
    ebitda_margin_pct,
    operating_margin_pct,
    ffo_margin_pct,
    return_on_equity_pct,
    price_to_ffo,
    trailing_pe,
    current_multiple,
    history_median_multiple,
    history_observations,
    multiple_vs_history,
    peer_median_multiple,
    peer_count,
    peer_basis,
    multiple_vs_peers,
    yield_vs_history,
    fcf_yield_pct,
    ffo,
    ffo_per_share,
    market_cap,
    currency
from graded
