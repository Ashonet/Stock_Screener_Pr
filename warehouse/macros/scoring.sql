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


{#
    Snap an implied payments-per-year to a real dividend frequency.

    Companies pay annually, semi-annually, quarterly, occasionally bi-monthly,
    or monthly. Nothing pays 5 or 11 times a year — those are artefacts of
    rounding an irregular median gap, and they appear whenever a payer's rhythm
    is disturbed:

      Delta suspended through COVID and resumed unevenly (gaps 56-140 days),
        implying 4.68/yr, which rounds to 5.
      Healthpeak switched quarterly -> monthly in 2025, implying 11.4/yr,
        which rounds to 11.

    Both are quarterly and monthly respectively. Snapping to the known set gets
    that right where rounding to the nearest integer does not, and it keeps the
    payment-count windows aligned to a real year.
#}
{% macro snap_to_dividend_frequency(median_gap_expr) -%}
    case
        when ({{ median_gap_expr }}) is null or ({{ median_gap_expr }}) <= 0 then null
        when 365.25 / ({{ median_gap_expr }}) < 1.5 then 1
        when 365.25 / ({{ median_gap_expr }}) < 3   then 2
        when 365.25 / ({{ median_gap_expr }}) < 5   then 4
        when 365.25 / ({{ median_gap_expr }}) < 9   then 6
        else 12
    end
{%- endmacro %}
