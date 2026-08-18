-- BUG: the extractor lower-cased only the first character of Yahoo's metric
-- names, so `annualEBITDA` became `eBITDA` and `annualEBIT` became `eBIT`. Both
-- silently resolved to null, blanking net-debt/EBITDA, interest coverage and
-- EBITDA margin on EVERY company. Nothing errored; the balance-sheet pillar
-- just quietly scored on one input instead of three.
--
-- Banks are exempt. EBITDA is not a meaningful measure for them, interest is
-- revenue, not a financing cost to add back, and Yahoo correctly omits it, so
-- including them would bury a real regression under expected nulls.
{{ config(severity = 'warn') }}

select
    f.symbol,
    d.industry,
    f.period_type,
    f.period_end,
    f.totalrevenue,
    f.ebitda
from {{ ref('fct_financials') }} f
join {{ ref('dim_security') }} d using (symbol)
where f.totalrevenue is not null
  and f.totalrevenue > 0
  and f.ebitda is null
  and coalesce(d.sector, '') != 'Financial Services'
