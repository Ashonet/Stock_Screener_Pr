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
    -- Observations written before the universe covered more than one index
    -- carry no index_name, and every one of them was the S&P 500. Defaulting
    -- keeps that history readable rather than orphaning it under a null.
    coalesce(index_name, 'sp500')    as index_name,
    cast(observed_at as timestamp)   as observed_at,
    cast(observed_at as date)        as observed_on,
    source
from raw
where symbol is not null
