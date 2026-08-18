/**
 * Tests for the income goal maths.
 *
 * The one that matters is the split. Dividends are not income on top of the
 * withdrawal, they are the part of it that arrives without selling, and
 * treating them as additional would tell someone they need a smaller portfolio
 * than they do.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildGoal, timeWeightedReturn, requiredContribution, buildContributionPlan } from '../public/js/goal.js';

const YEAR = 365.25 * 86_400_000;
const now = Date.UTC(2026, 0, 1);

describe('buildGoal', () => {
  test('required value is the target drawn at the withdrawal rate', () => {
    const g = buildGoal({ value: 100_000, annualDividends: 3000, target: 30_000, withdrawalRate: 3, now });
    assert.equal(g.requiredValue, 1_000_000);
    assert.equal(g.progressPct, 10);
    assert.equal(g.shortfall, 900_000);
  });

  test('the rate is the assumption doing all the work', () => {
    const at3 = buildGoal({ value: 1, target: 30_000, withdrawalRate: 3, now });
    const at4 = buildGoal({ value: 1, target: 30_000, withdrawalRate: 4, now });
    assert.equal(at3.requiredValue, 1_000_000);
    assert.equal(at4.requiredValue, 750_000);
  });

  test('what has to be sold is the rate less the yield', () => {
    // 3% drawn on a 1.2% yield leaves 1.8% to come from selling shares.
    const g = buildGoal({ value: 100_000, annualDividends: 1200, target: 30_000, withdrawalRate: 3, now });

    assert.ok(Math.abs(g.yieldPct - 1.2) < 1e-9);
    assert.ok(Math.abs(g.today.saleRatePct - 1.8) < 1e-9);
    assert.ok(Math.abs(g.today.withdrawal - 3000) < 1e-9);
    assert.ok(Math.abs(g.today.fromDividends - 1200) < 1e-9);
    assert.ok(Math.abs(g.today.fromSales - 1800) < 1e-9);
  });

  test('a yield above the withdrawal rate means selling nothing', () => {
    const g = buildGoal({ value: 100_000, annualDividends: 5000, target: 30_000, withdrawalRate: 3, now });

    assert.equal(g.today.fromSales, 0);
    assert.equal(g.today.saleRatePct, 0);
    assert.ok(Math.abs(g.today.surplus - 2000) < 1e-9, 'the excess stays rather than counting as a shortfall');
    assert.equal(g.today.coveredPct, 100);
  });

  test('dividends are part of the withdrawal, never added to it', () => {
    // The mistake this guards: treating a 3% yield as 3% on top of a 3% draw
    // would halve the portfolio someone thinks they need.
    const g = buildGoal({ value: 500_000, annualDividends: 15_000, target: 30_000, withdrawalRate: 3, now });

    assert.equal(g.requiredValue, 1_000_000, 'still a million, not five hundred thousand');
    assert.ok(Math.abs(g.atTarget.withdrawal - 30_000) < 1e-9);
    assert.ok(Math.abs(g.atTarget.fromDividends - 30_000) < 1e-9, 'a 3% yield covers a 3% draw exactly');
    assert.equal(g.atTarget.fromSales, 0);
  });

  test('the no-selling target is the value the yield alone would cover', () => {
    const g = buildGoal({ value: 100_000, annualDividends: 2000, target: 30_000, withdrawalRate: 3, now });
    // A 2% yield needs 1.5m to pay 30k without touching capital, against the
    // 1m that a 3% withdrawal needs.
    assert.equal(g.valueForDividendsAlone, 1_500_000);
    assert.equal(g.requiredValue, 1_000_000);
  });

  test('progress since the first purchase, annualised only over a year or more', () => {
    const g = buildGoal({
      value: 121_000,
      annualDividends: 3000,
      target: 30_000,
      startValue: 100_000,
      startedAt: now - 2 * YEAR,
      dividendsReceived: 5500,
      now,
    });

    assert.ok(Math.abs(g.sinceStart.grewBy - 21) < 1e-6);
    assert.ok(Math.abs(g.sinceStart.annualisedPct - 10) < 0.01, '21% over two years is 10% a year');
    assert.equal(g.sinceStart.dividendsReceived, 5500);
  });

  test('a few months held reports growth but not an annualised rate', () => {
    // Scaling a quarter to a year reports a rate the portfolio has never held.
    const g = buildGoal({
      value: 110_000,
      target: 30_000,
      startValue: 100_000,
      startedAt: now - YEAR / 4,
      now,
    });

    assert.ok(Math.abs(g.sinceStart.grewBy - 10) < 1e-6);
    assert.equal(g.sinceStart.annualisedPct, null);
  });

  test('progress is capped at 100 rather than running past the goal', () => {
    const g = buildGoal({ value: 2_000_000, annualDividends: 40_000, target: 30_000, withdrawalRate: 3, now });
    assert.equal(g.progressPct, 100);
    assert.equal(g.shortfall, 0);
  });

  test('missing or nonsensical inputs are refused, not guessed', () => {
    assert.equal(buildGoal({ value: 0, target: 30_000 }).ok, false);
    assert.equal(buildGoal({ value: 100, target: 0 }).ok, false);
    assert.equal(buildGoal({ value: 100, target: 30_000, withdrawalRate: 0 }).ok, false);
    assert.equal(buildGoal({ value: null, target: 30_000 }).reason, 'no-value');
    assert.equal(buildGoal({ value: 100, target: null }).reason, 'no-target');
  });

  test('a portfolio paying nothing still works, it just sells the lot', () => {
    const g = buildGoal({ value: 100_000, annualDividends: 0, target: 30_000, withdrawalRate: 3, now });

    assert.equal(g.yieldPct, 0);
    assert.equal(g.today.saleRatePct, 3);
    assert.ok(Math.abs(g.today.fromSales - 3000) < 1e-9);
    assert.equal(g.valueForDividendsAlone, null, 'no yield means no no-selling target exists');
  });
});

describe('growth since the first purchase is not a return', () => {
  test('no annual rate is published when holdings were bought later', () => {
    // The wallet that prompted this: 3,550 to 16,089 over four years, mostly by
    // buying more. Compounding that prints "42% a year" on a portfolio that
    // never made it.
    const g = buildGoal({
      value: 16_089,
      annualDividends: 533,
      target: 30_000,
      startValue: 3550,
      startedAt: now - 4.3 * YEAR,
      contributions: 2,
      now,
    });

    assert.ok(g.sinceStart.grewBy > 350, 'the change is still reported');
    assert.equal(g.sinceStart.annualisedPct, null, 'but not as a rate');
    assert.equal(g.sinceStart.withContributions, true);
    assert.equal(g.sinceStart.contributions, 2);
  });

  test('a rate is published when nothing was added after the start', () => {
    const g = buildGoal({
      value: 121_000,
      target: 30_000,
      startValue: 100_000,
      startedAt: now - 2 * YEAR,
      contributions: 0,
      now,
    });

    assert.ok(Math.abs(g.sinceStart.annualisedPct - 10) < 0.01);
    assert.equal(g.sinceStart.withContributions, false);
  });
});

describe('timeWeightedReturn', () => {
  const day = 86_400_000;
  const t0 = Date.UTC(2024, 0, 1);
  const pts = (values, step = 365.25 * day) => values.map((c, i) => ({ t: t0 + i * step, c }));

  test('a contribution is not counted as a gain', () => {
    // 100 grows to 110, then 100 is paid in (210), then it grows to 231.
    // The return is 10% then 10%, so 21% total, not the 131% the raw change
    // from 100 to 231 would suggest.
    const points = [
      { t: t0, c: 100 },
      { t: t0 + 365.25 * day, c: 110 },
      { t: t0 + 366 * day, c: 210 },
      { t: t0 + 731 * day, c: 231 },
    ];
    const twr = timeWeightedReturn(points, [t0 + 366 * day]);

    assert.ok(Math.abs(twr.totalPct - 21) < 0.01, `got ${twr.totalPct}`);
    assert.ok(Math.abs(twr.annualisedPct - 10) < 0.2, `got ${twr.annualisedPct}`);
  });

  test('with no contributions it is just the change', () => {
    const twr = timeWeightedReturn(pts([100, 121]), []);
    assert.ok(Math.abs(twr.totalPct - 21) < 1e-9);
    assert.ok(Math.abs(twr.annualisedPct - 21) < 0.01, 'one year, so the rate is the change');
  });

  test('no annualised rate under a year', () => {
    const twr = timeWeightedReturn(pts([100, 110], 30 * day), []);
    assert.ok(twr.totalPct > 0);
    assert.equal(twr.annualisedPct, null);
  });

  test('too little to measure returns nothing rather than zero', () => {
    assert.equal(timeWeightedReturn([], []).totalPct, null);
    assert.equal(timeWeightedReturn([{ t: t0, c: 100 }], []).totalPct, null);
  });
});

describe('requiredContribution', () => {
  test('solves the payment that reaches the target', () => {
    // 10,000 growing at 7% for 10 years reaches 19,672, leaving 80,328 of a
    // 100,000 target to come from contributions.
    const c = requiredContribution({ value: 10_000, requiredValue: 100_000, years: 10, annualReturnPct: 7 });

    assert.ok(Math.abs(c.futureValueOfCurrent - 19_671.51) < 1, `got ${c.futureValueOfCurrent}`);
    // Check it by replaying the annuity forward.
    const fv = c.futureValueOfCurrent + c.perYear * ((1.07 ** 10 - 1) / 0.07);
    assert.ok(Math.abs(fv - 100_000) < 1, `annual payments reach ${fv}`);
  });

  test('the monthly figure is less than a twelfth of the yearly one', () => {
    // Paid through the year rather than at the end of it, so it compounds for
    // longer and less is needed.
    const c = requiredContribution({ value: 10_000, requiredValue: 100_000, years: 10, annualReturnPct: 7 });
    assert.ok(c.perMonth * 12 < c.perYear, `${c.perMonth * 12} should undercut ${c.perYear}`);
    assert.ok(c.perMonth * 12 > c.perYear * 0.9, 'but not by much');
  });

  test('a zero return divides the gap evenly rather than dividing by zero', () => {
    const c = requiredContribution({ value: 0, requiredValue: 120_000, years: 10, annualReturnPct: 0 });
    assert.equal(c.perYear, 12_000);
    assert.equal(c.perMonth, 1000);
  });

  test('already on track reports nothing needed, not a negative payment', () => {
    const c = requiredContribution({ value: 900_000, requiredValue: 1_000_000, years: 30, annualReturnPct: 7 });
    assert.equal(c.alreadyThere, true);
    assert.equal(c.perMonth, 0);
    assert.equal(c.perYear, 0);
  });

  test('nonsensical inputs are refused', () => {
    assert.equal(requiredContribution({ value: 1, requiredValue: 100, years: 0, annualReturnPct: 5 }), null);
    assert.equal(requiredContribution({ value: 1, requiredValue: 0, years: 10, annualReturnPct: 5 }), null);
    assert.equal(requiredContribution({ value: 1, requiredValue: 100, years: 10, annualReturnPct: null }), null);
  });
});

describe('buildContributionPlan', () => {
  const base = { value: 16_000, requiredValue: 1_000_000, years: 30 };

  test('reinvesting lowers what has to be contributed', () => {
    const plan = buildContributionPlan({ ...base, priceReturnPct: 1.6, yieldPct: 3.3 });

    assert.ok(plan.reinvested.perMonth < plan.spent.perMonth, 'reinvesting needs less in');
    assert.ok(plan.extraPerMonth > 0);
    assert.ok(Math.abs(plan.reinvested.annualReturnPct - 4.9) < 1e-9);
    assert.ok(Math.abs(plan.spent.annualReturnPct - 1.6) < 1e-9);
  });

  test('the gap is the cost of spending the dividends', () => {
    const plan = buildContributionPlan({ ...base, priceReturnPct: 1.6, yieldPct: 3.3 });
    assert.ok(Math.abs(plan.extraPerMonth - (plan.spent.perMonth - plan.reinvested.perMonth)) < 1e-9);
    assert.ok(Math.abs(plan.extraPerYear - (plan.spent.perYear - plan.reinvested.perYear)) < 1e-9);
  });

  test('a portfolio paying nothing makes the two policies identical', () => {
    const plan = buildContributionPlan({ ...base, priceReturnPct: 7, yieldPct: 0 });

    assert.equal(plan.identical, true);
    assert.equal(plan.reinvested.perMonth, plan.spent.perMonth);
    assert.equal(plan.extraPerMonth, 0);
  });

  test('reinvesting can clear the goal on its own while spending does not', () => {
    const plan = buildContributionPlan({ value: 400_000, requiredValue: 1_000_000, years: 30, priceReturnPct: 0.5, yieldPct: 3.5 });

    assert.equal(plan.reinvested.alreadyThere, true, 'compounds past the target unaided');
    assert.equal(plan.spent.alreadyThere, false, 'but not with the dividends taken out');
    assert.ok(plan.spent.perMonth > 0);
  });

  test('an unmeasurable return yields no plan rather than a guess', () => {
    assert.equal(buildContributionPlan({ ...base, priceReturnPct: null, yieldPct: 3 }), null);
  });
});
