-- BUG: Yahoo's chart endpoint caps the dividend event list at 168 entries on
-- range=max and drops the MIDDLE of it. Coca-Cola came back with 1962-2003 and
-- then 2026, with two decades silently missing. The chart looked plausible,
-- which is what made it dangerous. The fix was to request an explicit period
-- window instead of range=max.
--
-- Naively "no gaps allowed" is a false positive, because dividends genuinely
-- stop: T-Mobile paid one special dividend in 2013 and nothing until it
-- initiated a regular payout in 2023. That is a real ten-year gap.
--
-- The distinction that matters is whether the company was a REGULAR payer on
-- both sides of the gap. Losing data mid-record leaves a dense run of payments
-- either side; a genuine suspension does not. So a gap is only flagged when the
-- symbol paid at least four times in the three years before it AND at least
-- four times in the three years after.
with years as (
    select distinct symbol, calendar_year from {{ ref('fct_dividend_years') }}
),

gaps as (
    select
        symbol,
        calendar_year as gap_start,
        lead(calendar_year) over (partition by symbol order by calendar_year) as gap_end
    from years
),

candidate as (
    select symbol, gap_start, gap_end
    from gaps
    where gap_end is not null and gap_end - gap_start > 1
),

density as (
    select
        c.symbol,
        c.gap_start,
        c.gap_end,
        (select count(*) from {{ ref('fct_dividends') }} d
          where d.symbol = c.symbol
            and d.calendar_year between c.gap_start - 2 and c.gap_start) as payments_before,
        (select count(*) from {{ ref('fct_dividends') }} d
          where d.symbol = c.symbol
            and d.calendar_year between c.gap_end and c.gap_end + 2) as payments_after
    from candidate c
)

select *
from density
where payments_before >= 4
  and payments_after >= 4
