-- A symbol cannot be in the same index twice at once.
--
-- Partitioned by index as well as symbol. A company can hold membership in the
-- S&P 500 and the Nasdaq listing simultaneously, and comparing those two spells
-- against each other would report an overlap that is simply two indexes.
--
-- The SCD2 intervals are derived with a gaps-and-islands query over observation
-- dates, which is exactly the kind of logic that silently produces overlapping
-- spells when the island key is wrong. Overlaps would double-count members in
-- any point-in-time query, so this asserts the derivation stays sound.
with spells as (

    select
        symbol,
        index_name,
        valid_from,
        coalesce(valid_to, date '9999-12-31') as valid_to,
        lead(valid_from) over (partition by symbol, index_name order by valid_from) as next_valid_from
    from {{ ref('dim_index_membership') }}

)

select symbol, index_name, valid_from, valid_to, next_valid_from
from spells
where next_valid_from is not null
  and next_valid_from <= valid_to
