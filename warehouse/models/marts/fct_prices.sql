{{ config(materialized='incremental', unique_key=['symbol', 'trade_date']) }}

-- Daily bars, merged rather than appended.
--
-- Incremental on (symbol, trade_date): the extract re-fetches a week of overlap
-- every run so Yahoo's restatements land, and the merge lets a corrected close
-- replace the one already stored instead of duplicating it.
with prices as (

    select
        p.symbol,
        p.trade_date,
        p.open,
        p.high,
        p.low,
        p.close,
        p.adj_close,
        p.volume,
        p.ingested_at
    from {{ ref('stg_prices') }} p

    {% if is_incremental() %}
    -- Only reconsider the window that could have changed.
    where p.trade_date >= (select coalesce(max(trade_date), '1900-01-01'::date) - interval 10 day from {{ this }})
    {% endif %}

)

select
    symbol,
    trade_date,
    open,
    high,
    low,
    close,
    adj_close,
    volume,
    -- Total-return factor: adj_close is adjusted for splits *and* dividends, so
    -- its growth is return with distributions reinvested while close alone is
    -- price appreciation.
    case when close > 0 then adj_close / close end as total_return_factor,
    ingested_at
from prices
