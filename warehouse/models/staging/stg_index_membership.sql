-- Point-in-time observations of index membership, one row per symbol per run.
with raw as (

    select *
    from read_json_auto(
        '{{ var("raw_dir") }}/membership__*.jsonl*',
        format = 'newline_delimited',
        union_by_name = true
    )

)

select distinct
    upper(trim(symbol))              as symbol,
    cast(observed_at as timestamp)   as observed_at,
    cast(observed_at as date)        as observed_on,
    source
from raw
where symbol is not null
