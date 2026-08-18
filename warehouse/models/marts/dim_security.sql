-- One row per tracked security, with the REIT flag every downstream model
-- branches on.
select
    symbol,
    name,
    currency,
    exchange,
    quote_type,
    sector,
    industry,
    country,
    employees,
    website,
    description,
    market_cap,
    shares_outstanding,
    trailing_pe,
    dividend_yield_pct,
    five_year_avg_dividend_yield_pct,
    beta,
    current_price,
    target_mean_price,
    target_low_price,
    target_high_price,
    target_median_price,
    analyst_opinions,
    recommendation_key,
    recommendation_mean,
    current_ratio,
    forward_pe,
    peg_ratio,
    ex_dividend_epoch,
    short_percent_of_float,
    quarterly_earnings_growth,
    return_on_equity_pct,

    -- Yahoo files every REIT under an industry beginning "REIT - ". This one
    -- boolean decides whether a security is valued on FFO or on earnings, so it
    -- is defined once here rather than re-derived in each consuming model.
    coalesce(industry ilike 'REIT%', false) as is_reit,

    ingested_at
from {{ ref('stg_securities') }}
