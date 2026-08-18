-- Reported statement lines, long form: one row per symbol/period/metric.
--
-- Long rather than wide because statement coverage varies by industry, a
-- railway reports no R&D, a REIT reports no capex, and Yahoo adds and drops
-- lines without notice. Widening happens in the marts, where each consumer
-- picks the columns it needs.
with raw as (

    select *
    from read_json_auto(
        '{{ var("raw_dir") }}/financial__*.jsonl*',
        format = 'newline_delimited',
        union_by_name = true
    )

),

typed as (

    select
        upper(trim(symbol))             as symbol,
        lower(trim(period_type))        as period_type,
        cast(period_end as date)         as period_end,
        metric,
        cast(value as double)            as value,
        cast(_ingested_at as timestamp)  as ingested_at
    from raw
    where value is not null
      and period_end is not null

)

select *
from typed
qualify row_number() over (
    partition by symbol, period_type, period_end, metric
    order by ingested_at desc
) = 1
