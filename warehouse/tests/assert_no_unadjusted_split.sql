{{ config(severity='warn') }}

-- A fingerprint, deliberately kept at warning severity.
--
-- BUG: a split that never reached the stored history.
--
-- Monster Beverage split two for one on 11 August 2026. The close went 90.36 to
-- 45.53, the adjusted close went with it instead of correcting for it, and the
-- volume doubled. Nothing errored. The price series simply carried a permanent
-- 50% cliff, and every return measured across it was halved: MNST read -29.0%
-- over the year when it had made about +42.0%, a seventy-one point error inside
-- a column that looked entirely ordinary.
--
-- The first diagnosis was that the incremental extract's week of overlap was
-- too short to pick up a split, and it was wrong: re-fetching the entire
-- history changed nothing. Yahoo publishes the 2:1 in its own split events feed
-- and leaves `adjclose` unadjusted across it, so the upstream value is simply
-- incorrect and no amount of re-reading will fix it. The warehouse applies the
-- ratio itself, in `int_split_corrections` and `fct_prices`.
--
-- This looks for the shape of the problem: a one-day move sitting on a share
-- ratio with the adjusted close having moved just as far. It is a warning and
-- not an error because shape is not proof, and the project has been here
-- before. The Trade Desk fell 33% on results in February 2025, which lands
-- close enough to three for two to be flagged, and it was no such thing.
--
-- `assert_missed_splits_are_corrected` is the version that fails the build. It
-- reasons from the published split event rather than the shape of the move, so
-- it cannot mistake a bad quarter for a corporate action. What this one adds is
-- reach: it can point at a symbol whose split event was never captured, which
-- the precise test is blind to by construction.
with daily as (

    select
        symbol,
        trade_date,
        close,
        adj_close,
        lag(close)     over (partition by symbol order by trade_date) as previous_close,
        lag(adj_close) over (partition by symbol order by trade_date) as previous_adj_close
    from {{ ref('fct_prices') }}

),

moves as (

    select
        symbol,
        trade_date,
        close,
        previous_close,
        close / previous_close as ratio,
        -- If a split had been applied, the adjusted series would be continuous
        -- across the day while the raw series stepped. Equal ratios mean no
        -- adjustment was applied to either.
        abs((close / previous_close) - (adj_close / previous_adj_close)) as adjustment_gap
    from daily
    where previous_close > 0
      and previous_adj_close > 0

)

select
    symbol,
    trade_date,
    previous_close,
    close,
    ratio,
    'one-day move sits on a share-split ratio and the adjusted close did not correct for it' as diagnosis
from moves
where adjustment_gap < 0.001
  and (
    abs(ratio - 0.5)      < 0.005   -- 2 for 1
    or abs(ratio - 0.25)  < 0.005   -- 4 for 1
    or abs(ratio - 0.3333) < 0.005  -- 3 for 1
    or abs(ratio - 0.6667) < 0.005  -- 3 for 2
    or abs(ratio - 2.0)   < 0.02    -- 1 for 2 reverse
    or abs(ratio - 3.0)   < 0.03    -- 1 for 3 reverse
  )
