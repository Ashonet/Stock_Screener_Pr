-- Index membership as a slowly-changing dimension (Type 2).
--
-- This model exists to keep survivorship bias out of the warehouse. The
-- constituent file holds *today's* members, so six years of history for "the
-- S&P 500" would silently exclude every company that was removed, and removals
-- skew heavily toward failures, delistings and takeunders. Any historical study
-- over current members alone reports the survivors' returns and calls them the
-- index's.
--
-- Folding the append-only observations into valid_from / valid_to intervals
-- makes membership at any past date reconstructable:
--
--   select symbol from dim_index_membership
--   where index_name = 'sp500'
--     and '2025-03-01' between valid_from and coalesce(valid_to, '9999-12-31')
--
-- A symbol can hold membership in several indexes at once, with different
-- spells in each, so every step below partitions by index as well as symbol.
-- Collapsing them would let a company leaving the S&P 500 look like it had left
-- the Nasdaq listing too.
--
-- Intervals are closed-open in spirit: valid_to is the last date the symbol was
-- still observed as a member, and null while it is current.
with observations as (

    -- Distinct at *day* granularity, which is the grain the islands below are
    -- built on. Staging dedupes on the observation timestamp, so two runs on
    -- one date leave two rows per symbol, and the row_number inside the island
    -- key then counts a symbol twice for a single date and splits its spell in
    -- half. A latent bug until the universe covered more than one index and
    -- made it visible as 1,006 spells across 503 companies.
    select distinct symbol, index_name, observed_on
    from {{ ref('stg_index_membership') }}

),

observation_dates as (

    select distinct index_name, observed_on
    from observations

),

-- Rank every run date so consecutive presence can be detected as an unbroken
-- run of observations rather than by comparing raw dates.
numbered_dates as (

    select
        index_name,
        observed_on,
        -- Ranked within the index: the universe builder can be run for one
        -- index and not another, so their run dates do not line up.
        row_number() over (partition by index_name order by observed_on) as date_seq
    from observation_dates

),

symbol_observations as (

    select
        o.symbol,
        o.index_name,
        o.observed_on,
        d.date_seq,
        -- Gaps-and-islands: a symbol present in consecutive runs keeps the same
        -- island id, and a break in presence starts a new one.
        d.date_seq - row_number() over (partition by o.symbol, o.index_name order by d.date_seq) as island
    from observations o
    join numbered_dates d using (index_name, observed_on)

),

spells as (

    select
        symbol,
        index_name,
        island,
        min(observed_on) as valid_from,
        max(observed_on) as last_observed_on,
        count(*)         as observations
    from symbol_observations
    group by symbol, index_name, island

),

latest_run as (

    select index_name, max(observed_on) as latest_observed_on
    from observation_dates
    group by index_name

)

select
    s.symbol,
    s.index_name,
    s.valid_from,
    -- Still present in the most recent run means still a member; anything else
    -- left the index somewhere between its last sighting and the next run.
    case when s.last_observed_on = l.latest_observed_on then null else s.last_observed_on end as valid_to,
    s.last_observed_on = l.latest_observed_on as is_current,
    s.observations,
    l.latest_observed_on as universe_last_refreshed_on
from spells s
join latest_run l using (index_name)
