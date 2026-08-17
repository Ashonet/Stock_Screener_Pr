-- Daily bars from the landing zone.
--
-- The raw layer is append-only, so a symbol/date can appear many times: the
-- extract deliberately re-fetches a week of overlap on every run to pick up
-- Yahoo's restatements (a split or dividend rewrites prior closes). The last
-- ingested row for a key therefore wins.
with raw as (

    select *
    from read_json_auto(
        '{{ var("raw_dir") }}/price__*.jsonl*',
        format = 'newline_delimited',
        union_by_name = true
    )

),

typed as (

    select
        upper(trim(symbol))            as symbol,
        cast(trade_date as date)       as trade_date,
        cast(open as double)           as open,
        cast(high as double)           as high,
        cast(low as double)            as low,
        cast(close as double)          as close,
        cast(adj_close as double)      as adj_close,
        cast(volume as bigint)         as volume,
        cast(_ingested_at as timestamp) as ingested_at
    from raw
    where close is not null
      and close > 0

)

select *
from typed
qualify row_number() over (
    partition by symbol, trade_date
    order by ingested_at desc
) = 1
