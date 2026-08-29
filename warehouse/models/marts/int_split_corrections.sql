-- Splits the upstream published but did not apply to its own adjusted close.
--
-- BUG: Monster Beverage split two for one on 11 August 2026. Yahoo reported the
-- split in its events feed and left `adjclose` stepping down with the raw close
-- instead of correcting for it, so the stored series carried a permanent 50%
-- cliff and every return measured across it was halved. MNST read -29% over the
-- year against roughly +42% actual. Re-fetching does not help, because the
-- upstream data is simply wrong; the correction has to be applied here.
--
-- The repair cannot be applied blindly to every split, because most of them
-- *are* handled upstream and adjusting again would break the ones that work.
-- So each split is inspected: if the adjusted close stepped by the same
-- proportion as the raw close on the day, no adjustment was applied and this
-- warehouse owes one. If the adjusted series ran continuously across the step,
-- the upstream did its job and nothing is owed.
with splits as (

    select symbol, split_date, ratio
    from {{ ref('stg_splits') }}

),

-- The bar on the split date and the one before it, which is where the step
-- either shows up in both series or in only one.
around as (

    select
        p.symbol,
        p.trade_date,
        p.close,
        p.adj_close,
        lag(p.close)     over (partition by p.symbol order by p.trade_date) as previous_close,
        lag(p.adj_close) over (partition by p.symbol order by p.trade_date) as previous_adj_close
    from {{ ref('stg_prices') }} p

),

inspected as (

    select
        s.symbol,
        s.split_date,
        s.ratio,
        a.close / nullif(a.previous_close, 0)         as close_step,
        a.adj_close / nullif(a.previous_adj_close, 0) as adj_step
    from splits s
    join around a
      on a.symbol = s.symbol
     and a.trade_date = s.split_date
    where a.previous_close > 0
      and a.previous_adj_close > 0

)

select
    symbol,
    split_date,
    ratio,
    close_step,
    adj_step,
    -- Two conditions, and the first is the one that matters.
    --
    -- The raw close is *also* split-adjusted upstream for the splits Yahoo
    -- handles, so a properly applied split leaves no step in either series and
    -- both simply move with the market that day. Testing only that the two
    -- series agree therefore flags every correctly handled split as broken,
    -- which is exactly what it did to Monster's 2023 two for one: a 1.4% day
    -- where close and adjusted close moved together, read as a missed split and
    -- doubling three years of prior history.
    --
    -- What actually marks a missed split is the raw close stepping by the split
    -- ratio itself. The second condition then confirms the adjusted series
    -- failed to correct for it rather than having done so.
    --
    -- The third condition is the one that keeps this honest, and it exists
    -- because widening the universe to the small-cap tail broke the other two.
    --
    -- A "split" of 1.05 is a 5% stock dividend, and it implies a price step of
    -- 4.8%. The tolerance around that step is 4.76%. The two overlap almost
    -- entirely, so any ordinary day matched: Security National was flagged on a
    -- 0.5% drift, and Cresud on a day its shares went *up*. Twenty-one of the
    -- twenty-seven flagged events were stock dividends of a few percent that no
    -- detector can separate from a quiet day, because the signal and the noise
    -- are genuinely the same size.
    --
    -- So a split must move the price by more than a quarter to be judged here
    -- at all. Real splits clear that easily: two for one steps 50%, and the
    -- reverse splits in this data step 900% to 7,900%. What falls below it is
    -- declined rather than guessed, and the asymmetry is deliberate. A missed
    -- correction leaves the series as the upstream published it, which is one
    -- symbol reading wrong. A wrongly applied one silently rewrites years of
    -- history at the wrong scale, which is how this model's first version
    -- doubled three years of Monster's prices. Cotiviti's 0.9 sits in the grey
    -- zone at an 11% step and is deliberately left alone.
    --
    -- assert_no_unadjusted_split stays at warning severity as the net beneath
    -- this: anything genuinely missed still surfaces, without failing a build.
    abs(1 - (1.0 / ratio)) > 0.25
        and abs(close_step - (1.0 / ratio)) < 0.05 / ratio
        and abs(close_step - adj_step) < 0.001 as upstream_missed_it
from inspected
