-- Dividends totalled per calendar year — the shape the dashboard charts.
--
-- The in-progress year is flagged rather than dropped: charting a part-year
-- beside complete ones reads as a cut, so consumers need to know which it is.
select
    symbol,
    calendar_year,
    sum(amount)                                   as amount,
    count(*)                                      as payments,
    max(payments_per_year)                        as payments_per_year,
    calendar_year = date_part('year', current_date) as is_partial_year
from {{ ref('fct_dividends') }}
group by symbol, calendar_year
