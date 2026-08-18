-- Every split the upstream failed to apply must have been corrected here.
--
-- The precise version of the check. `int_split_corrections` identifies a missed
-- split from the split event itself, which is ground truth, so this cannot fire
-- on a company that merely fell by a third on results day.
--
-- It fails when a missed split exists and the prices before it are still on the
-- old share count, which is what happens after an incremental run: the model
-- only rewrites its lookback window, so the rest of the history keeps the old
-- scale until `dbt build --full-refresh`. That is the fix when this fires.
with missed as (

    select symbol, split_date, ratio
    from {{ ref('int_split_corrections') }}
    where upstream_missed_it

),

-- The bar immediately before each missed split, which is the one that must
-- have been restated onto today's share count.
before_split as (

    select
        m.symbol,
        m.split_date,
        m.ratio,
        max(p.trade_date) as last_trade_date
    from missed m
    join {{ ref('fct_prices') }} p
      on p.symbol = m.symbol
     and p.trade_date < m.split_date
    group by m.symbol, m.split_date, m.ratio

)

select
    b.symbol,
    b.split_date,
    b.ratio,
    p.correction_factor,
    'a split the upstream ignored is still uncorrected here, run dbt build --full-refresh' as diagnosis
from before_split b
join {{ ref('fct_prices') }} p
  on p.symbol = b.symbol
 and p.trade_date = b.last_trade_date
-- The factor on the bar before a missed split has to carry that split's ratio.
where p.correction_factor is null
   or abs(p.correction_factor - b.ratio) > 0.001
