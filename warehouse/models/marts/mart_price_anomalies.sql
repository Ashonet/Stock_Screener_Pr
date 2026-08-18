-- Daily moves far outside what a symbol normally does.
--
-- Data quality as monitoring rather than assertion. The suite already has fifty
-- tests, and every one encodes a rule someone thought of in advance. This model
-- covers the other case: a value that breaks no rule and is still wrong,
-- because a bad tick, a missed split adjustment or a mis-mapped symbol usually
-- shows up first as a move nothing else explains.
--
-- Measured against the symbol's own trailing volatility rather than a fixed
-- threshold. A 6% day is unremarkable for a small-cap biotech and would be the
-- largest move in a decade for a utility, so one cutoff across five hundred
-- companies flags the volatile ones every week and never catches a real fault
-- in the quiet ones.
--
-- **A flag is not a defect.** Earnings, guidance and takeovers all produce
-- genuine ten-sigma days, and a real market has far fatter tails than the
-- normal distribution this borrows its language from. The point is a short
-- ranked list to look at, not a verdict, which is why it is a mart and not a
-- test that fails the build.
{% set window_days = 90 %}
{% set sigma_threshold = 8 %}

with daily as (

    select
        symbol,
        trade_date,
        close,
        adj_close,
        lag(adj_close) over (partition by symbol order by trade_date) as previous_adj_close
    from {{ ref('fct_prices') }}

),

returns as (

    select
        symbol,
        trade_date,
        close,
        adj_close,
        (adj_close / previous_adj_close - 1) * 100 as daily_return_pct
    from daily
    where previous_adj_close > 0

),

-- Trailing statistics that exclude the day being judged, so a large move does
-- not widen the very band it is being measured against.
banded as (

    select
        *,
        avg(daily_return_pct) over (
            partition by symbol order by trade_date
            rows between {{ window_days }} preceding and 1 preceding
        ) as trailing_mean,
        stddev_samp(daily_return_pct) over (
            partition by symbol order by trade_date
            rows between {{ window_days }} preceding and 1 preceding
        ) as trailing_stddev,
        count(*) over (
            partition by symbol order by trade_date
            rows between {{ window_days }} preceding and 1 preceding
        ) as trailing_observations
    from returns

)

select
    symbol,
    trade_date,
    close,
    daily_return_pct,
    trailing_mean,
    trailing_stddev,
    (daily_return_pct - trailing_mean) / trailing_stddev as sigma,
    trailing_observations
from banded
-- A near-zero deviation makes the ratio explode on any move at all, which is
-- how a stock that has not budged in three months gets flagged for a 0.4% day.
where trailing_stddev > 0.05
  and trailing_observations >= {{ window_days // 2 }}
  and abs(daily_return_pct - trailing_mean) / trailing_stddev >= {{ sigma_threshold }}
order by abs(sigma) desc
