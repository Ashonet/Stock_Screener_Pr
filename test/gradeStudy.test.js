/**
 * Tests for the grade-portfolio study.
 *
 * The failure to guard against is a portfolio return that is not one: an
 * equal-weight basket held without rebalancing returns the mean of its members,
 * and quietly using a median instead would report a number no portfolio earned.
 * Both are published here, because they answer different questions, and the
 * tests pin which is which.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { gradePortfolios, gradesAsOf, GRADE_ORDER } from '../lib/gradeStudy.js';

const rows = (pairs) => pairs.map(([symbol, totalReturn]) => ({ symbol, totalReturn }));
const grading = (pairs) => new Map(pairs);

describe('gradePortfolios', () => {
  test('an equal-weight basket returns the mean of its members', () => {
    // Equal money into each and held: the basket's return is the plain average.
    const study = gradePortfolios(
      rows([
        ['AAA', 10],
        ['BBB', 30],
      ]),
      grading([
        ['AAA', 'A'],
        ['BBB', 'A'],
      ]),
      1,
    );

    assert.equal(study.rows[0].totalReturn, 20);
    assert.equal(study.rows[0].count, 2);
  });

  test('the median is reported separately, because one holding can carry a mean', () => {
    // The real case: a 39x holding in a bucket of ordinary ones. The mean is
    // what the portfolio actually made and the median is what its typical
    // member did, and the gap between them is the finding.
    const study = gradePortfolios(
      rows([
        ['A1', 5],
        ['A2', 10],
        ['A3', 15],
        ['MOON', 3800],
      ]),
      grading([
        ['A1', 'D'],
        ['A2', 'D'],
        ['A3', 'D'],
        ['MOON', 'D'],
      ]),
      1,
    );

    const row = study.rows[0];
    assert.equal(row.totalReturn, 957.5, 'the mean, which the portfolio really earned');
    assert.equal(row.medianReturn, 12.5, 'the median, which its typical member earned');
    assert.equal(row.best.symbol, 'MOON');
  });

  test('grades come back in ladder order, not the order they arrived', () => {
    const study = gradePortfolios(
      rows([
        ['F1', 1],
        ['A1', 2],
        ['C1', 3],
      ]),
      grading([
        ['F1', 'F'],
        ['A1', 'A+'],
        ['C1', 'C'],
      ]),
      1,
    );

    assert.deepEqual(
      study.rows.map((r) => r.grade),
      ['A+', 'C', 'F'],
    );
  });

  test('the spread is top grade less bottom, and can be negative', () => {
    // A negative spread means the ladder did not hold over the window, which is
    // a result rather than a bug, and the sign has to survive to say so.
    const study = gradePortfolios(
      rows([
        ['A1', 10],
        ['F1', 60],
      ]),
      grading([
        ['A1', 'A+'],
        ['F1', 'F'],
      ]),
      1,
    );

    assert.equal(study.spread, -50);
    assert.equal(study.topGrade, 'A+');
    assert.equal(study.bottomGrade, 'F');
  });

  test('an ungraded symbol is left out of the grades but stays in the universe', () => {
    const study = gradePortfolios(
      rows([
        ['A1', 10],
        ['UNKNOWN', 100],
      ]),
      grading([['A1', 'A']]),
      1,
    );

    assert.equal(study.rows.length, 1);
    assert.equal(study.rows[0].count, 1);
    assert.equal(study.universeCount, 2, 'the universe average covers everything priced');
    assert.equal(study.universeMean, 55);
  });

  test('annualising is withheld under a year', () => {
    const one = gradePortfolios(rows([['A1', 100]]), grading([['A1', 'A']]), 1);
    const part = gradePortfolios(rows([['A1', 100]]), grading([['A1', 'A']]), 0.5);

    assert.ok(Math.abs(one.rows[0].annualisedReturn - 100) < 1e-9);
    assert.equal(part.rows[0].annualisedReturn, null);
  });

  test('a three-year double annualises to about 26%', () => {
    const study = gradePortfolios(rows([['A1', 100]]), grading([['A1', 'A']]), 3);
    assert.ok(Math.abs(study.rows[0].annualisedReturn - 25.99) < 0.05);
  });

  test('nothing to study yields empty rather than throwing', () => {
    const study = gradePortfolios([], new Map(), 1);
    assert.deepEqual(study.rows, []);
    assert.equal(study.universeMean, null);
    assert.equal(study.spread, null);
  });
});

describe('gradesAsOf', () => {
  const timelines = new Map([
    [
      'AAA',
      [
        { period: '2022-12-31', grade: 'C' },
        { period: '2023-12-31', grade: 'B' },
        { period: '2024-12-31', grade: 'A' },
      ],
    ],
  ]);

  test('takes the last period that had closed by the date', () => {
    assert.equal(gradesAsOf(timelines, '2024-06-30').get('AAA'), 'B');
    assert.equal(gradesAsOf(timelines, '2025-06-30').get('AAA'), 'A');
  });

  test('a date before any statement leaves the symbol ungraded', () => {
    // Never guessed forward: assigning a 2024 grade to a 2021 portfolio is the
    // look-ahead this whole distinction exists to avoid.
    assert.equal(gradesAsOf(timelines, '2021-06-30').has('AAA'), false);
  });

  test('the boundary is inclusive of a period ending exactly then', () => {
    assert.equal(gradesAsOf(timelines, '2023-12-31').get('AAA'), 'B');
  });
});

describe('GRADE_ORDER', () => {
  test('runs best to worst, which everything downstream relies on', () => {
    assert.equal(GRADE_ORDER[0], 'A+');
    assert.equal(GRADE_ORDER.at(-1), 'F');
    assert.equal(GRADE_ORDER.length, 8);
  });
});
