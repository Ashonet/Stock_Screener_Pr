-- Figures the upstream changed after first reporting them.
--
-- A restatement is not a data error, it is the world working normally:
-- companies revise, auditors adjust, and Yahoo re-maps a line. It matters here
-- because everything historical in this warehouse is computed from the current
-- version, so a figure that moved is a figure whose past grades were computed
-- from something nobody could have seen at the time.
--
-- Only genuine changes appear. An unchanged figure re-observed on every run has
-- one version and is absent, which is what keeps this a list of restatements
-- rather than a list of pipeline runs.
with versioned as (

    select *
    from {{ ref('fct_financial_knowledge') }}
    where total_versions > 1

),

paired as (

    select
        symbol,
        period_type,
        period_end,
        metric,
        version_seq,
        value,
        known_from,
        lag(value)      over (partition by symbol, period_type, period_end, metric order by version_seq) as previous_value,
        lag(known_from) over (partition by symbol, period_type, period_end, metric order by version_seq) as previously_known_from
    from versioned

)

select
    symbol,
    period_type,
    period_end,
    metric,
    version_seq,
    previous_value                  as restated_from,
    value                           as restated_to,
    previously_known_from           as first_known_at,
    known_from                      as restated_at,
    case
        when previous_value is null or previous_value = 0 then null
        else (value - previous_value) / abs(previous_value) * 100
    end                             as change_pct,
    -- How long the superseded figure stood, which is roughly how long anything
    -- derived from it was wrong.
    date_diff('day', previously_known_from, known_from) as days_before_restated
from paired
where version_seq > 1
order by abs(coalesce(change_pct, 0)) desc, symbol, period_end
