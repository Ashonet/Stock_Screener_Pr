-- Freshness: a pipeline that silently stops updating is worse than one that
-- fails, because the dashboard keeps serving stale prices as though they were
-- current.
--
-- Allows four days so a long weekend or a holiday does not cry wolf.
{{ config(severity = 'warn') }}

select
    max(trade_date) as latest_trade_date,
    date_diff('day', max(trade_date), current_date) as days_stale
from {{ ref('fct_prices') }}
having date_diff('day', max(trade_date), current_date) > 4
