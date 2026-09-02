-- Nothing below the floor survives into the security dimension.
--
-- Deliberately not asserted against fct_prices. That model is incremental, so
-- rows for a symbol that has since fallen below the floor stay in the table
-- until a --full-refresh, and a test that fails on a correct incremental run
-- would block every build until someone rebuilt the whole warehouse.
select
    symbol,
    market_cap
from {{ ref('dim_security') }}
where market_cap is not null
  and market_cap < {{ var('min_market_cap') }}
