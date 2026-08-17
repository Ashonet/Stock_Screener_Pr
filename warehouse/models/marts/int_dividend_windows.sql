-- Trailing-twelve-month dividend totals, bucketed by payment *count*.
--
-- This is the model that fixes the dividend-growth bug. Calendar-year totals
-- misread every monthly payer, because whether a distribution lands on 31 Dec
-- or 1 Jan swings the year by a whole payment. Bucketing the payment sequence
-- into groups of `payments_per_year` counts the same number of payments in
-- every window, so a raise reads as a raise.
--
-- window_index 0 is the most recent full year, 1 the one before it, and so on.
with bucketed as (

    select
        symbol,
        amount,
        payments_per_year,
        -- Count backwards from the newest payment so window 0 is always complete.
        cast(floor((payments_total - payment_seq) / nullif(payments_per_year, 0)) as integer) as window_index,
        payments_total,
        pay_date
    from {{ ref('fct_dividends') }}
    where payments_per_year is not null

),

windowed as (

    select
        symbol,
        window_index,
        sum(amount)     as amount,
        count(*)        as payments,
        max(payments_per_year) as payments_per_year,
        min(pay_date)   as window_start,
        max(pay_date)   as window_end
    from bucketed
    group by symbol, window_index

)

select *
from windowed
-- Drop the oldest bucket when it is a partial year, so a short first window
-- cannot masquerade as a dividend cut.
where payments = payments_per_year
