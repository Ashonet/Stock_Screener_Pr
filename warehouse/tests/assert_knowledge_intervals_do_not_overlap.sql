-- Gaps-and-islands logic is exactly the sort that quietly produces overlapping
-- intervals, and an overlap here is worse than useless: an "as of" query would
-- return two different values for the same figure on the same date, and
-- whichever the reader saw first would look authoritative.
--
-- The same guard `assert_membership_spells_do_not_overlap` puts on
-- dim_index_membership, for the same reason.
with intervals as (

    select
        symbol,
        period_type,
        period_end,
        metric,
        known_from,
        known_to,
        lead(known_from) over (
            partition by symbol, period_type, period_end, metric
            order by known_from
        ) as next_known_from
    from {{ ref('fct_financial_knowledge') }}

)

select
    symbol,
    period_type,
    period_end,
    metric,
    known_from,
    known_to,
    next_known_from,
    'knowledge intervals overlap for this figure' as diagnosis
from intervals
where next_known_from is not null
  and (
    -- An open-ended version followed by another is an overlap by definition:
    -- the first claims to still be current while the second has started.
    known_to is null
    -- Otherwise the close must land exactly on the next start, or the
    -- timeline either double counts or has a hole in it.
    or known_to > next_known_from
  )
