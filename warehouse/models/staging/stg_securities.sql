-- Company profile and valuation snapshot; latest ingest per symbol wins.
with raw as (

    select *
    from read_json_auto(
        '{{ var("raw_dir") }}/security__*.jsonl*',
        format = 'newline_delimited',
        union_by_name = true
    )

),

typed as (

    select
        upper(trim(symbol))                        as symbol,
        name,
        coalesce(currency, 'USD')                  as currency,
        exchange,
        quote_type,
        sector,
        industry,
        country,
        website,
        description,
        -- Every numeric goes through varchar and try_cast rather than a direct
        -- cast. The raw layer is untrusted by design, and Yahoo signals "no
        -- value" with an empty object rather than null — market_cap: {} for
        -- Salesforce, dividend_yield: {} for Amazon. A direct cast fails the
        -- whole build on one bad cell; try_cast nulls that cell and lets the
        -- rest through, which is what a staging layer is for.
        try_cast(cast(employees as varchar) as bigint)          as employees,
        try_cast(cast(market_cap as varchar) as double)         as market_cap,
        try_cast(cast(shares_outstanding as varchar) as double) as shares_outstanding,
        try_cast(cast(trailing_pe as varchar) as double)        as trailing_pe,
        -- Yahoo hands back dividend yield as a fraction here and as a percent
        -- in fiveYearAvgDividendYield. Normalise both to percent at the edge so
        -- nothing downstream has to remember which is which.
        try_cast(cast(dividend_yield as varchar) as double) * 100 as dividend_yield_pct,
        try_cast(cast(five_year_avg_dividend_yield as varchar) as double) as five_year_avg_dividend_yield_pct,
        try_cast(cast(beta as varchar) as double)              as beta,
        try_cast(cast(current_price as varchar) as double)     as current_price,
        try_cast(cast(target_mean_price as varchar) as double) as target_mean_price,
        recommendation_key,
        try_cast(cast(return_on_equity as varchar) as double) * 100 as return_on_equity_pct,
        cast(_ingested_at as timestamp)            as ingested_at
    from raw
    where symbol is not null

)

select *
from typed
qualify row_number() over (partition by symbol order by ingested_at desc) = 1
