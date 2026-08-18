-- Daily snapshots of the score mart, written by mart_quality_score's post-hook.
--
-- History lives in the append-only raw layer rather than in a dbt snapshot,
-- because a snapshot needs a target that survives between runs and this
-- warehouse is derived: it is gitignored and rebuilt from raw every time, so a
-- snapshot table would reset to empty on each build. Writing the day's scores
-- back into raw keeps history durable under the same rules as every other
-- source, and it survives a full --full-refresh.
{% if raw_files_exist('score_history__*.jsonl*') %}

with raw as (

    select *
    from read_json_auto(
        '{{ var("raw_dir") }}/score_history__*.jsonl*',
        format = 'newline_delimited',
        union_by_name = true
    )

)

select
    upper(trim(symbol))                 as symbol,
    cast(score_date as date)            as score_date,
    scoring_basis,
    try_cast(overall_score as double)   as overall_score,
    grade,
    try_cast(coverage_pct as double)          as coverage_pct,
    try_cast(pillar_dividend as double)       as pillar_dividend,
    try_cast(pillar_balance_sheet as double)  as pillar_balance_sheet,
    try_cast(pillar_growth as double)         as pillar_growth,
    try_cast(pillar_profitability as double)  as pillar_profitability,
    try_cast(pillar_valuation as double)      as pillar_valuation
from raw
where symbol is not null
qualify row_number() over (partition by symbol, cast(score_date as date) order by overall_score) = 1

{% else %}

-- Cold start: the post-hook has not written a history file yet. Emit the right
-- shape with no rows so downstream models compile and simply have nothing to
-- report, rather than failing the build.
select
    cast(null as varchar) as symbol,
    cast(null as date)    as score_date,
    cast(null as varchar) as scoring_basis,
    cast(null as double)  as overall_score,
    cast(null as varchar) as grade,
    cast(null as double)  as coverage_pct,
    cast(null as double)  as pillar_dividend,
    cast(null as double)  as pillar_balance_sheet,
    cast(null as double)  as pillar_growth,
    cast(null as double)  as pillar_profitability,
    cast(null as double)  as pillar_valuation
where false

{% endif %}
