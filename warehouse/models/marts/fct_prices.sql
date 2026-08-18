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

),

/*
 * Repair for splits the upstream published and then ignored.
 *
 * Yahoo reported Monster's 2:1 on 11 August 2026 in its own events feed and
 * left `adjclose` stepping down alongside the raw close instead of correcting
 * for it. The stored series carried a permanent 50% cliff, and every return
 * measured across it was halved: MNST read -29% over the year against roughly
 * +42% actual. Re-fetching does not help, because the upstream value is simply
 * wrong, so the adjustment is applied here.
 *
 * `int_split_corrections` decides which splits were missed, because most are
 * handled upstream and adjusting those again would break the ones that work.
 *
 * For whoever hits this next: the model is incremental, so a newly discovered
 * missed split only rewrites rows inside the lookback window and the rest of
 * the history stays on the old scale until `dbt build --full-refresh`.
 * `assert_no_unadjusted_split` is what tells you that is needed.
 */
missed_splits as (

    select symbol, split_date, ratio
    from {{ ref('int_split_corrections') }}
    where upstream_missed_it

),

corrections as (

    select
        p.symbol,
        p.trade_date,
        -- Every missed split that happened after this bar, multiplied together,
        -- which restates the price onto today's share count. DuckDB has no
        -- product aggregate, so it is done in logs.
        coalesce(exp(sum(ln(m.ratio))), 1) as correction_factor
    from prices p
    left join missed_splits m
      on m.symbol = p.symbol
     and m.split_date > p.trade_date
    group by p.symbol, p.trade_date

)

select
    p.symbol,
    p.trade_date,
    p.open,
    p.high,
    p.low,
    p.close,
    -- The corrected series, which is what every return in the app is measured
    -- on. A split the upstream ignored no longer reads as a 50% loss.
    p.adj_close / c.correction_factor as adj_close,
    -- Kept alongside so the repair is visible rather than silent, and so the
    -- size of the upstream's error stays auditable.
    p.adj_close                       as adj_close_reported,
    c.correction_factor,
    p.volume,
    -- Total-return factor: adj_close is adjusted for splits *and* dividends, so
    -- its growth is return with distributions reinvested while close alone is
    -- price appreciation.
    case when p.close > 0 then (p.adj_close / c.correction_factor) / p.close end as total_return_factor,
    p.ingested_at
from prices p
join corrections c
  on c.symbol = p.symbol
 and c.trade_date = p.trade_date
