-- BUG: the payout ratio was computed from a single reported year, which is far
-- too jumpy to grade on. Coca-Cola's 2025 free cash flow was held down by a
-- one-off multi-billion tax deposit, printing a 166% payout on a dividend that
-- is comfortably covered. The scorer now averages three years.
--
-- A payout above 200% of distributable cash is either a genuine distress signal
-- or a data problem, and either way someone should look. REITs are held to a
-- higher bar than operating companies but not an unlimited one.
{{ config(severity = 'warn') }}

select
    symbol,
    scoring_basis,
    payout_pct,
    payout_years
from {{ ref('mart_quality_score') }}
where payout_pct is not null
  and payout_pct > 200
