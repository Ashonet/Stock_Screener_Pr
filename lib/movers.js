/**
 * Which two score snapshots a range compares, and what the gap between them
 * actually is.
 *
 * The dashboard is otherwise entirely a snapshot: every view answers "what is
 * true now" and none of them answers "what changed". The scores have been
 * stored since the pipeline started, so the answer is a subtraction — but the
 * subtraction is the easy half, and picking what to subtract from is where this
 * can quietly lie.
 *
 * ## Two ways this misleads if it is careless
 *
 * **The snapshot asked for usually does not exist.** Scores are written when
 * the pipeline runs, not daily, so "one month" lands on a date nothing was
 * written. The nearest snapshot on or before the cutoff is used instead, and
 * the date actually compared is returned so the view can say "against 24 Aug"
 * rather than implying a month.
 *
 * **The universe changes size.** It went from 505 companies to 1,972 on
 * 2026-08-29 when the full listing was loaded, and back to 1,973 after the
 * market-cap floor. So most companies have no score at all in the older
 * snapshots, and treating a missing prior score as a change would announce
 * 1,467 companies as having leapt to an A when they were simply not being
 * scored yet. Those are reported separately as newly covered, never as movers.
 */

/** The ranges the view offers, longest history first in the picker. */
export const MOVER_RANGES = [
  { key: '1d', label: '1D', days: 1 },
  { key: '5d', label: '5D', days: 5 },
  { key: '1m', label: '1M', days: 30 },
  { key: '3m', label: '3M', days: 91 },
  { key: '6m', label: '6M', days: 182 },
  { key: '1y', label: '1Y', days: 365 },
  { key: '3y', label: '3Y', days: 1095 },
];

const DAY_MS = 86_400_000;

export const isValidMoverRange = (key) => MOVER_RANGES.some((r) => r.key === key);

const asDay = (value) => {
  if (!value) return null;
  const text = typeof value === 'string' ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};

/**
 * Pick the pair of snapshots a range compares.
 *
 * @param {(string|Date)[]} snapshots  every score_date on record, any order
 * @param {string} rangeKey            one of MOVER_RANGES
 * @returns {object|null} { to, from, requested, days, gapDays, exact, oldest, covered }
 *   `from` is null when nothing is old enough, and `oldest` then says how far
 *   back the record actually goes so the view can explain rather than blank.
 */
export function comparisonSnapshot(snapshots = [], rangeKey = '1d') {
  const range = MOVER_RANGES.find((r) => r.key === rangeKey);
  if (!range) return null;

  const days = [...new Set((snapshots ?? []).map(asDay).filter(Boolean))].sort();
  if (!days.length) return null;

  const to = days.at(-1);
  const requested = new Date(Date.parse(`${to}T00:00:00Z`) - range.days * DAY_MS).toISOString().slice(0, 10);

  // On or before the cutoff, never after: comparing against a *later* snapshot
  // because it happens to be closer would report a shorter period than the one
  // the reader asked for, in the direction that flatters recent movement.
  const eligible = days.filter((day) => day <= requested);
  const from = eligible.length ? eligible.at(-1) : null;

  return {
    to,
    from,
    requested,
    days: range.days,
    // What was really compared, which is rarely what was asked for.
    gapDays: from ? Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) : null,
    exact: from === requested,
    oldest: days[0],
    covered: days.length,
  };
}

/**
 * Split scored rows into movers and companies that were not scored before.
 *
 * A company with no prior score has not moved; it has arrived. Counting it as a
 * mover is how a universe expanding from 505 names to 1,973 would have read as
 * the greatest week of quality improvement in market history.
 */
export function splitMovers(rows = []) {
  const movers = [];
  const newlyCovered = [];

  for (const row of rows) {
    if (row.previousScore == null) newlyCovered.push(row);
    else if (row.change !== 0) movers.push(row);
  }

  movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || b.score - a.score);
  newlyCovered.sort((a, b) => b.score - a.score);

  return {
    movers,
    newlyCovered,
    // Scored on both dates and unchanged. Reported as a count rather than a
    // list: "nothing happened to these 1,470" is one fact, not 1,470 rows.
    unchanged: rows.length - movers.length - newlyCovered.length,
    up: movers.filter((m) => m.change > 0).length,
    down: movers.filter((m) => m.change < 0).length,
    regraded: movers.filter((m) => m.gradeChanged).length,
  };
}

/* ------------------------------------------------------- reconstructed history */

/**
 * Which record answers a range, and why.
 *
 * Three sources, and they are not interchangeable:
 *
 *   recorded       the snapshots the pipeline actually wrote. The real thing,
 *                  the whole universe, and it moves daily because the score
 *                  includes price. It only reaches back as far as the pipeline
 *                  has been running.
 *
 *   reconstructed  the score recomputed from statements, restricted at every
 *                  date to what had been reported by then. It reaches back as
 *                  far as the statements do, but it is not what was recorded at
 *                  the time and it only changes when a company reports.
 *
 * Recorded wins whenever it reaches, because a real snapshot beats a
 * reconstruction of one. Below that, quarterly statements are preferred to
 * annual: an annual score steps once a year, so over three months it says
 * eleven companies moved where the quarterly reconstruction finds two hundred
 * and ninety-one. Beyond quarterly's reach, annual is all there is.
 *
 * Both ends of a comparison always come from the same source. Mixing them would
 * subtract a reconstruction from a recorded snapshot and report the difference
 * between two methods as a change in a company.
 */
export function pickBasis({ rangeKey, snapshots = [], quarterlyFrom = null, annualFrom = null }) {
  const window = comparisonSnapshot(snapshots, rangeKey);
  if (!window) return null;

  if (window.from) return { basis: 'recorded', window };

  const range = MOVER_RANGES.find((r) => r.key === rangeKey);
  const cutoff = new Date(Date.parse(`${window.to}T00:00:00Z`) - range.days * DAY_MS).toISOString().slice(0, 10);

  if (quarterlyFrom && cutoff >= quarterlyFrom) {
    return { basis: 'reconstructed', periodType: 'quarterly', from: cutoff, to: window.to, window };
  }
  if (annualFrom && cutoff >= annualFrom) {
    return { basis: 'reconstructed', periodType: 'annual', from: cutoff, to: window.to, window };
  }

  return {
    basis: 'none',
    window,
    // The earliest date any reconstruction could speak to, so the view can say
    // how far back the record goes rather than only that this range is empty.
    earliest: [quarterlyFrom, annualFrom].filter(Boolean).sort()[0] ?? null,
  };
}

/**
 * Movers from a pair of point-in-time scores per company.
 *
 * @param {object[]} pairs  [{ symbol, now, was }] from scoreOnDate at each end
 * @param {Map} meta        symbol -> { name, sector }
 *
 * Same shape the recorded path produces, so the view renders one thing. A
 * company priced at only one end is newly covered rather than a mover, exactly
 * as it is for recorded snapshots and for the same reason.
 */
export function moversFromPairs(pairs = [], meta = new Map()) {
  const rows = [];

  for (const { symbol, now, was } of pairs) {
    if (!now) continue;
    const info = meta.get(symbol) ?? {};
    rows.push({
      symbol,
      name: info.name ?? symbol,
      sector: info.sector ?? null,
      grade: now.grade,
      score: now.score,
      coveragePct: now.coverage ?? null,
      previousScore: was ? was.score : null,
      previousGrade: was ? was.grade : null,
      change: was ? now.score - was.score : null,
      gradeChanged: Boolean(was && was.grade !== now.grade),
      // Which statements each end rested on. The score moves with price in
      // between, so these are usually the same date at both ends over a short
      // window, and that is worth being able to see.
      asOfPeriod: now.period,
      previousPeriod: was ? was.period : null,
    });
  }

  return rows;
}
