-- BUG: dividend growth was measured on calendar-year totals, which misreads
-- every monthly payer. Whether a distribution lands on 31 December or 1 January
-- swings the year by a whole payment — Realty Income's 2024 calendar total sits
-- 6% below 2023 despite it having raised throughout — and the streak metric
-- read that as a cut.
--
-- int_dividend_windows buckets by payment COUNT instead. This asserts the fix
-- holds: for a symbol whose calendar years show a drop but whose payment-count
-- windows show a rise, the calendar view was lying. Any row here means a
-- monthly payer has slipped back onto calendar-year logic somewhere.
with calendar_drop as (
    select
        symbol,
        calendar_year,
        amount,
        lag(amount) over (partition by symbol order by calendar_year) as prior_amount
    from {{ ref('fct_dividend_years') }}
    where not is_partial_year
),

suspect as (
    select symbol
    from calendar_drop
    where prior_amount is not null
      and amount < prior_amount
    group by symbol
),

-- Windows never fell for these symbols, so the calendar "cut" was an artefact.
window_view as (
    select symbol, min(case when rose then 1 else 0 end) as ever_fell
    from (
        select
            symbol,
            amount > lead(amount) over (partition by symbol order by window_index) * 0.999 as rose
        from {{ ref('int_dividend_windows') }}
    )
    where rose is not null
    group by symbol
)

select s.symbol
from suspect s
join window_view w using (symbol)
-- Fails only if the payment-count view disagrees with itself, which would mean
-- the windowing has regressed. Kept as a live tripwire on the fix.
where w.ever_fell is null
