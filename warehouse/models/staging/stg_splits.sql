-- Share splits, as the upstream reports them.
--
-- Kept as its own entity because the adjusted close cannot be relied on to
-- carry them, so the ratio has to be applied by this warehouse rather than
-- assumed to have been applied already.
with raw as (

    select *
    from read_json_auto(
        '{{ var("raw_dir") }}/split__*.jsonl*',
        format = 'newline_delimited',
        union_by_name = true
    )

),

typed as (

    select
        upper(trim(symbol))               as symbol,
        cast(split_date as date)          as split_date,
        try_cast(numerator as double)     as numerator,
        try_cast(denominator as double)   as denominator,
        cast(_ingested_at as timestamp)   as ingested_at
    from raw
    where symbol is not null
      and split_date is not null

)

select
    symbol,
    split_date,
    numerator,
    denominator,
    -- Shares held multiply by this. A 2:1 split gives two shares for one, so
    -- the ratio is 2 and every price before it is worth half as much per share
    -- in today's terms.
    numerator / denominator as ratio,
    ingested_at
from typed
where numerator > 0
  and denominator > 0
  and numerator / denominator <> 1
qualify row_number() over (partition by symbol, split_date order by ingested_at desc) = 1
