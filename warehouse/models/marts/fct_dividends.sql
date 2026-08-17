-- Individual payments, plus the per-symbol payment cadence.
--
-- Cadence matters: dividend growth must be measured over a fixed number of
-- payments, not over calendar years. A monthly payer whose distribution lands
-- on 31 December in one year and 1 January the next shows a calendar-year drop
-- that never happened — Realty Income's 2024 calendar total sits 6% below 2023
-- while it raised throughout.
with payments as (

    select
        symbol,
        pay_date,
        amount,
        row_number() over (partition by symbol order by pay_date) as payment_seq,
        count(*)    over (partition by symbol)                    as payments_total
    from {{ ref('stg_dividends') }}

),

-- Gap between consecutive payments. Computed in its own step because a window
-- function cannot be nested inside an aggregate.
gaps as (

    select
        symbol,
        pay_date,
        date_diff('day', lag(pay_date) over (partition by symbol order by pay_date), pay_date) as gap_days
    from {{ ref('stg_dividends') }}

),

cadence as (

    select
        symbol,
        median(gap_days) as median_gap_days,
        -- Median, not mean: one missed or doubled payment would drag an average
        -- across the boundary between quarterly and monthly.
        --
        -- Recent payments only, because companies change frequency. Agree Realty
        -- moved from quarterly to monthly in 2021; a median across its full
        -- twenty-year record sits between the two regimes. What matters for
        -- measuring current dividend growth is the cadence in force now.
        {{ snap_to_dividend_frequency('median(gap_days)') }} as payments_per_year
    from gaps
    where gap_days is not null
      and pay_date >= current_date - interval 3 year
    group by symbol

),

-- A payer that has stopped distributing has no recent gaps, so fall back to its
-- full history rather than dropping it from the cadence table entirely.
cadence_fallback as (

    select
        symbol,
        {{ snap_to_dividend_frequency('median(gap_days)') }} as payments_per_year
    from gaps
    where gap_days is not null
    group by symbol

)

select
    p.symbol,
    p.pay_date,
    p.amount,
    p.payment_seq,
    p.payments_total,
    coalesce(c.payments_per_year, f.payments_per_year) as payments_per_year,
    date_part('year', p.pay_date) as calendar_year
from payments p
left join cadence c using (symbol)
left join cadence_fallback f using (symbol)
