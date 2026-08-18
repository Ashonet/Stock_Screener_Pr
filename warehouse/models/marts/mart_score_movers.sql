-- The securities whose quality score moved most since the previous observation.
--
-- Empty until the pipeline has run on two separate days, which is correct: a
-- change needs two observations, and inventing one would be worse than showing
-- nothing.
select
    h.symbol,
    d.name,
    d.sector,
    h.scoring_basis,
    h.score_date,
    h.previous_score_date,
    h.overall_score,
    h.previous_score,
    h.score_change,
    h.grade,
    h.previous_grade,
    h.grade_changed
from {{ ref('fct_score_history') }} h
left join {{ ref('dim_security') }} d using (symbol)
where h.is_latest
  and h.score_change is not null
order by abs(h.score_change) desc
