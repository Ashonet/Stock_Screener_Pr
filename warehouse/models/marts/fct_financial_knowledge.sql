-- What we knew about each reported figure, and when we knew it.
--
-- The warehouse is otherwise unitemporal: it stores what is true for a period
-- and silently replaces it when the upstream restates. That is fine for a
-- screener and wrong for anything historical, because a grade computed for
-- FY2023 from statements as they read today is not the grade anyone could have
-- seen in 2023. The score history says as much in its own documentation; this
-- model is what would let that caveat be removed.
--
-- Two time axes, which is what makes it bitemporal:
--
--   period_end              when the figure was true of
--   known_from / known_to   when we held this version of it
--
-- So "revenue for FY2024 as we understood it on 1 March 2025" is:
--
--   select value from fct_financial_knowledge
--   where symbol = 'AAPL' and metric = 'totalRevenue' and period_end = '2024-09-30'
--     and date '2025-03-01' >= known_from
--     and (known_to is null or date '2025-03-01' < known_to)
--
-- A new interval opens only when the value actually changes. The extract
-- re-fetches statements on a staleness window, so an unchanged figure is
-- observed dozens of times, and opening an interval per observation would turn
-- a table of restatements into a table of pipeline runs.
--
-- Currently every figure has exactly one version: the pipeline is days old and
-- nothing has been restated yet. The structure accumulates from here, and no
-- amount of cleverness recovers what was reported before it existed, which is
-- the same bounded and visible bias `dim_index_membership` carries.
with observations as (

    select
        symbol,
        period_type,
        period_end,
        metric,
        value,
        ingested_at
    from {{ ref('stg_financials_versions') }}

),

-- Collapse repeat observations of one run into a single point per key, since
-- an extract can write the same figure more than once within a run.
per_run as (

    select
        symbol,
        period_type,
        period_end,
        metric,
        value,
        min(ingested_at) as observed_at
    from observations
    group by symbol, period_type, period_end, metric, value

),

-- Gaps and islands over the value: a version starts wherever the figure
-- differs from the one observed before it.
sequenced as (

    select
        *,
        lag(value) over (
            partition by symbol, period_type, period_end, metric
            order by observed_at
        ) as previous_value,
        row_number() over (
            partition by symbol, period_type, period_end, metric
            order by observed_at
        ) as observation_seq
    from per_run

),

changes as (

    select
        *,
        case
            -- `is distinct from` rather than <>, so a figure appearing or
            -- disappearing counts as a change. Null <> anything is null, and a
            -- null comparison here would silently drop the version where a
            -- metric stopped being reported.
            when observation_seq = 1 then 1
            when value is distinct from previous_value then 1
            else 0
        end as is_new_version
    from sequenced

),

versions as (

    select
        *,
        sum(is_new_version) over (
            partition by symbol, period_type, period_end, metric
            order by observed_at
            rows between unbounded preceding and current row
        ) as version_seq
    from changes

),

intervals as (

    select
        symbol,
        period_type,
        period_end,
        metric,
        version_seq,
        any_value(value)  as value,
        min(observed_at)  as known_from
    from versions
    group by symbol, period_type, period_end, metric, version_seq

)

select
    symbol,
    period_type,
    period_end,
    metric,
    value,
    version_seq,
    known_from,
    -- Open-ended while current. The next version's start closes this one, so
    -- the intervals tile the timeline without overlapping.
    lead(known_from) over (
        partition by symbol, period_type, period_end, metric
        order by version_seq
    ) as known_to,
    count(*) over (
        partition by symbol, period_type, period_end, metric
    ) as total_versions
from intervals
-- The market-cap floor, kept in step with fct_financials.
where symbol not in ({{ below_market_cap_floor() }})
