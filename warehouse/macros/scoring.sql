{#
    Map a value onto 0-100 by linear interpolation between a "poor" and a
    "great" anchor. Pass great < poor when lower is better (leverage, P/E).
#}
{% macro score_between(value, poor, great) -%}
    case
        when {{ value }} is null then null
        else greatest(0, least(100,
            (({{ value }} - ({{ poor }})) / nullif(({{ great }}) - ({{ poor }}), 0)) * 100
        ))
    end
{%- endmacro %}


{#
    Weighted mean that renormalises over whatever is non-null, so a pillar with
    a missing input is scored on the inputs it has rather than dropping to zero.
    `parts` is a list of [expression, weight] pairs.
#}
{% macro weighted_score(parts) -%}
    (
        ({% for p in parts %}coalesce(({{ p[0] }}) * {{ p[1] }}, 0){{ " + " if not loop.last }}{% endfor %})
        / nullif({% for p in parts %}(case when ({{ p[0] }}) is not null then {{ p[1] }} else 0 end){{ " + " if not loop.last }}{% endfor %}, 0)
    )
{%- endmacro %}


{# Compound annual growth rate; null unless both ends are positive. #}
{% macro cagr(first_value, last_value, years) -%}
    case
        when {{ first_value }} is null or {{ last_value }} is null then null
        when {{ first_value }} <= 0 or {{ last_value }} <= 0 then null
        when {{ years }} <= 0 then null
        else (pow({{ last_value }} / {{ first_value }}, 1.0 / {{ years }}) - 1) * 100
    end
{%- endmacro %}


{# Pull one metric out of the long statement table. #}
{% macro metric(name) -%}
    max(case when metric = '{{ name }}' then value end) as {{ name | lower }}
{%- endmacro %}
