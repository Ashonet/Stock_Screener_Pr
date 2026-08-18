-- BUG: the grade was derived from the unrounded score while the card displayed
-- the rounded one, so they disagreed at every boundary. Realty Income scored
-- 72.6, displayed as "73", and graded as B, while the published ladder says 73
-- is a B+. Two sources of truth for one number.
--
-- Asserts the letter always matches the number the reader is shown.
select
    symbol,
    overall_score,
    grade
from {{ ref('mart_quality_score') }}
where overall_score is not null
  and grade != case
        when overall_score >= 88 then 'A+'
        when overall_score >= 80 then 'A'
        when overall_score >= 73 then 'B+'
        when overall_score >= 66 then 'B'
        when overall_score >= 58 then 'C+'
        when overall_score >= 50 then 'C'
        when overall_score >= 40 then 'D'
        else 'F'
    end
