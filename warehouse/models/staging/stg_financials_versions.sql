-- Every observation of every reported figure, versions and all.
--
-- `stg_financials` keeps the last row for a key and discards the rest, which is
-- right for "what is true" and destroys the ability to ask "what did we know".
-- The raw layer holds both, because it is append-only, so the versions are
-- there on disk and only the staging step throws them away. This view is the
-- same source read without that discard.
--
-- Nothing here is deduplicated. A figure re-fetched unchanged appears once per
-- run, and collapsing those into knowledge intervals is the next model's job.
with raw as (

    select *
    from read_json_auto(
        '{{ var("raw_dir") }}/financial__*.jsonl*',
        format = 'newline_delimited',
        union_by_name = true
    )

)

select
    upper(trim(symbol))                              as symbol,
    lower(trim(period_type))                         as period_type,
    cast(period_end as date)                         as period_end,
    trim(metric)                                     as metric,
    -- The same defensive cast the main staging layer uses: Yahoo signals "no
    -- value" with an empty object, and a direct cast fails the whole build on
    -- one bad cell.
    try_cast(cast(value as varchar) as double)       as value,
    cast(_ingested_at as timestamp)                  as ingested_at
from raw
where symbol is not null
  and period_end is not null
  and metric is not null
