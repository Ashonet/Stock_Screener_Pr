-- Individual dividend payments.
with raw as (

    select *
    from read_json_auto(
        '{{ var("raw_dir") }}/dividend__*.jsonl',
        format = 'newline_delimited',
        union_by_name = true
    )

),

typed as (

    select
        upper(trim(symbol))             as symbol,
        cast(pay_date as date)           as pay_date,
        cast(amount as double)           as amount,
        cast(_ingested_at as timestamp)  as ingested_at
    from raw
    where amount is not null
      and amount > 0

)

select *
from typed
qualify row_number() over (partition by symbol, pay_date order by ingested_at desc) = 1
