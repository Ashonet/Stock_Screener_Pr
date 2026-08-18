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
        coalesce(dividend_yield_pct >= 1 and five_year_avg_dividend_yield_pct > 0, false) as yield_history_usable
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
             else {{ score_between('fcf_yield_pct', 2, 8) }} end as s_valuation_yield

    from flagged

),

pillars as (

    select
        *,
        {{ weighted_score([['s_payout', 0.55], ['s_streak', 0.45]]) }} as pillar_dividend,
        {{ weighted_score([['s_leverage', 0.5], ['s_coverage', 0.3], ['s_debt_assets', 0.2]]) }} as pillar_balance_sheet,
        {{ weighted_score([['s_revenue_growth', 0.35], ['s_per_share_growth', 0.4], ['s_dividend_growth', 0.25]]) }} as pillar_growth,
        {{ weighted_score([['s_margin', 0.5], ['s_returns', 0.5]]) }} as pillar_profitability,
        {{ weighted_score([['s_valuation_multiple', 0.6], ['s_valuation_yield', 0.4]]) }} as pillar_valuation
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
    yield_vs_history,
    fcf_yield_pct,
    ffo,
    ffo_per_share,
    market_cap,
    currency
from graded
