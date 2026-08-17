-- The AFFO proxy, and the evidence for it.
--
-- The scorer approximates a REIT's distributable cash with operating cash flow
-- rather than the textbook FFO minus recurring capex. The reason is coverage:
-- Yahoo reports no capital expenditure line for a material share of REITs
-- (Realty Income and Prologis among them), so a true AFFO is simply not
-- computable for all of them.
--
-- Note this is NOT "no REIT reports capex" — an earlier read of two tickers
-- suggested that and it was wrong. Most do. But mixing true AFFO for some REITs
-- with a cash-flow proxy for others would make the payout column incomparable
-- across the screener, which is the one thing a screener must not be. So the
-- proxy is applied uniformly and this test records the coverage.
--
-- It fails only if capex becomes available for EVERY REIT, at which point the
-- proxy should be replaced with a real AFFO.
{{ config(severity = 'warn') }}

with coverage as (
    select
        count(distinct f.symbol) filter (where f.capitalexpenditure is not null) as reits_with_capex,
        count(distinct f.symbol)                                                 as reits_total
    from {{ ref('fct_financials') }} f
    join {{ ref('dim_security') }} d using (symbol)
    where d.is_reit
)

select *
from coverage
where reits_total > 0
  and reits_with_capex = reits_total
