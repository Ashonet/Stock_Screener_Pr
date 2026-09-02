-- Statement lines pivoted to one row per symbol/period.
--
-- The long staging table is the source of truth; this is the convenience shape
-- the app and the scoring model read. Adding a line item means adding a column
-- here, not migrating the raw layer.
with pivoted as (

    select
        symbol,
        period_type,
        period_end,

        {{ metric('totalRevenue') }},
        {{ metric('costOfRevenue') }},
        {{ metric('grossProfit') }},
        {{ metric('researchAndDevelopment') }},
        {{ metric('sellingGeneralAndAdministration') }},
        {{ metric('otherOperatingExpenses') }},
        {{ metric('operatingExpense') }},
        {{ metric('totalExpenses') }},
        {{ metric('operatingIncome') }},
        {{ metric('otherNonOperatingIncomeExpenses') }},
        {{ metric('interestIncome') }},
        {{ metric('interestExpense') }},
        {{ metric('netInterestIncome') }},
        {{ metric('pretaxIncome') }},
        {{ metric('taxProvision') }},
        {{ metric('taxRateForCalcs') }},
        {{ metric('netIncome') }},
        {{ metric('dilutedEPS') }},
        {{ metric('basicEPS') }},
        {{ metric('dilutedAverageShares') }},
        {{ metric('reconciledDepreciation') }},
        {{ metric('depreciationAndAmortization') }},
        {{ metric('ebitda') }},
        {{ metric('ebit') }},
        {{ metric('operatingCashFlow') }},
        {{ metric('capitalExpenditure') }},
        {{ metric('freeCashFlow') }},
        {{ metric('totalDebt') }},
        {{ metric('cashAndCashEquivalents') }},
        {{ metric('stockholdersEquity') }},
        {{ metric('totalAssets') }},
        {{ metric('cashDividendsPaid') }},

        max(ingested_at) as ingested_at
    from {{ ref('stg_financials') }}
    group by symbol, period_type, period_end

)

select
    p.*,
    -- FFO: the REIT earnings replacement. Depreciation on property that is
    -- typically holding its value pushes reported earnings far below the cash
    -- produced, so EPS, P/E and an earnings payout ratio all misread for a REIT.
    -- Estimated as net income + D&A; true NAREIT FFO also strips gains on
    -- property sales and adds back impairments, which Yahoo does not report.
    case
        when d.is_reit and p.netincome is not null and p.depreciationandamortization is not null
            then p.netincome + p.depreciationandamortization
    end as ffo,

    case when p.totalrevenue > 0 then p.netincome / p.totalrevenue * 100 end as net_margin_pct,
    case when p.totalrevenue > 0 then p.operatingincome / p.totalrevenue * 100 end as operating_margin_pct,
    case when p.totalrevenue > 0 then p.ebitda / p.totalrevenue * 100 end as ebitda_margin_pct,

    row_number() over (partition by p.symbol, p.period_type order by p.period_end desc) as recency_rank
from pivoted p
-- Inner, not left. The floor lives in dim_security, so joining to it is what
-- applies it here; and fct_financials.symbol already has a relationships test
-- against that dimension, so a row this drops is one the test would have failed
-- on anyway. Left-joining kept statements for companies the warehouse no longer
-- carries, with every dimension column null beside them.
join {{ ref('dim_security') }} d using (symbol)
