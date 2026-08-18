{#
    Does the landing zone hold any file matching this pattern?

    DuckDB raises IO Error on a glob that matches nothing, so a model reading an
    entity that has not been produced yet would fail the whole build. That is a
    real cold-start case here: score history is written by mart_quality_score's
    post-hook, so on the very first build of a fresh clone the files do not exist
    yet. glob() returns zero rows rather than erroring, which makes it a safe
    probe at compile time.
#}
{% macro raw_files_exist(pattern) -%}
    {%- if execute -%}
        {%- set probe = run_query("select count(*) as n from glob('" ~ var('raw_dir') ~ "/" ~ pattern ~ "')") -%}
        {{ return(probe is not none and probe.columns[0].values()[0] > 0) }}
    {%- else -%}
        {{ return(false) }}
    {%- endif -%}
{%- endmacro %}


{#
    Append the day's scores to the landing zone.

    The path is built in Jinja rather than in SQL because DuckDB's COPY ... TO
    takes a literal destination, 'prefix' || expression is a parser error.
#}
{% macro export_score_history() -%}
    copy (
        select
            current_date as score_date,
            symbol,
            scoring_basis,
            overall_score,
            grade,
            coverage_pct,
            pillar_dividend,
            pillar_balance_sheet,
            pillar_growth,
            pillar_profitability,
            pillar_valuation
        from {{ this }}
    )
    to '{{ var("raw_dir") }}/score_history__{{ run_started_at.strftime("%Y-%m-%d") }}.jsonl.gz'
    (format json, compression gzip)
{%- endmacro %}
