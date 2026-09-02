{#
    Symbols known to sit below the market-cap floor.

    Written as "exclude what is known to be too small" rather than "keep what is
    known to be big enough", and the difference matters twice:

      - `market_cap` is null for a few dozen securities where Yahoo returned an
        empty object. Unknown is not the same as small, and dropping a company
        because a field failed to arrive would be a silent data loss dressed up
        as a policy.
      - the wide tier fetches prices without a profile, so those symbols have no
        row in stg_securities at all. Keeping them is what stops a floor on
        company size from quietly deleting price history for anything the
        pipeline never profiled.

    stg_securities is deduped to the latest ingest per symbol, so this yields at
    most one row per symbol and is safe on the right-hand side of NOT IN.
#}
{% macro below_market_cap_floor() -%}
    select symbol
    from {{ ref('stg_securities') }}
    where symbol is not null
      and market_cap is not null
      and market_cap < {{ var('min_market_cap') }}
{%- endmacro %}
