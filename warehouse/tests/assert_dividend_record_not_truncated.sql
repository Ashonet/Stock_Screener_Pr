-- BUG: Yahoo's chart endpoint caps the dividend event list at 168 entries on
-- range=max and drops the MIDDLE of it. Coca-Cola came back with 1962-2003 and
-- then 2026 — two decades missing behind a chart that looked entirely
-- plausible. Fixed by requesting an explicit period window instead.
--
-- This test started life as "a payer's dividend years must be contiguous", then
-- as "...unless it was not a regular payer either side of the gap". Both were
-- wrong. Across the S&P 500 there are 44 multi-year gaps and every one is a
-- real corporate event: the 2008 crisis (AIG, Citigroup, Carnival, Freeport),
-- COVID (Delta, Southwest, Marriott, Expedia, Disney), and one-offs like PG&E's
-- bankruptcy and HCA's leveraged buyout. Suspensions are ordinary, and a
-- company that suspends was almost always a regular payer on both sides — so
-- gap shape cannot separate a suspension from a truncation, and any test built
-- on it is 44 false positives pretending to be signal.
--
-- What IS unambiguous is the truncation fingerprint: the response pinned to
-- exactly the 168-entry cap, with history missing from the middle. A genuine
-- record lands on 168 only by coincidence, and coincidence plus an interior
-- multi-year gap is the thing worth failing on. Realty Income currently holds
-- 239 payments, which is itself evidence the explicit-window fix is holding.
with counts as (

    select symbol, count(*) as payments
    from {{ ref('fct_dividends') }}
    group by symbol

),

years as (

    select distinct symbol, calendar_year
    from {{ ref('fct_dividend_years') }}

),

interior_gaps as (

    select symbol
    from (
        select
            symbol,
            calendar_year,
            lead(calendar_year) over (partition by symbol order by calendar_year) as next_year
        from years
    )
    where next_year is not null
      and next_year - calendar_year > 1
    group by symbol

)

select
    c.symbol,
    c.payments,
    'dividend record sits exactly on the 168-entry API cap and has an interior gap' as diagnosis
from counts c
join interior_gaps g using (symbol)
where c.payments = 168
