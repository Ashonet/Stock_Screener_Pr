-- A symbol cannot be in the index twice at once.
--
-- The SCD2 intervals are derived with a gaps-and-islands query over observation
-- dates, which is exactly the kind of logic that silently produces overlapping
-- spells when the island key is wrong. Overlaps would double-count members in
-- any point-in-time query, so this asserts the derivation stays sound.
with spells as (

    select
        symbol,
        valid_from,
        coalesce(valid_to, date '9999-12-31') as valid_to,
        lead(valid_from) over (partition by symbol order by valid_from) as next_valid_from
    from {{ ref('dim_index_membership') }}

)

select symbol, valid_from, valid_to, next_valid_from
from spells
where next_valid_from is not null
  and next_valid_from <= valid_to
