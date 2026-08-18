-- One row per symbol per scoring date, with the move since the previous score.
--
-- This is the clearest answer to "why a warehouse instead of calling the API?"
-- A live API can tell you what a company looks like now. It cannot tell you what
-- changed, because nobody stored yesterday.
select
    symbol,
    score_date,
    scoring_basis,
    overall_score,
    grade,
    coverage_pct,
    pillar_dividend,
    pillar_balance_sheet,
    pillar_growth,
    pillar_profitability,
    pillar_valuation,

    lag(overall_score) over (partition by symbol order by score_date) as previous_score,
    lag(grade)         over (partition by symbol order by score_date) as previous_grade,
    lag(score_date)    over (partition by symbol order by score_date) as previous_score_date,

    overall_score - lag(overall_score) over (partition by symbol order by score_date) as score_change,
    grade is distinct from lag(grade) over (partition by symbol order by score_date)  as grade_changed,

    row_number() over (partition by symbol order by score_date desc) = 1 as is_latest
from {{ ref('stg_score_history') }}
