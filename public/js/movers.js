/**
 * What the quality scores did, and over what period they really did it.
 *
 * Every other view in this dashboard is a snapshot: they answer "what is true
 * now" and none of them answers "what changed". This is the subtraction, and
 * almost all of the care here goes into the two ways a subtraction misleads.
 *
 * The period named on the button is not usually the period measured. Scores are
 * written when the pipeline runs rather than every day, so "5D" lands on a date
 * nothing was written and falls back to the nearest snapshot before it — nine
 * days, on the record as it stands. The heading says the dates and the real gap
 * rather than the label, because a reader comparing nine days of movement under
 * a five-day heading is being told something false by omission.
 *
 * And a company with no earlier score has not improved, it has arrived. The
 * universe went from 505 names to 1,973 in August, so on the 5D view 1,467
 * companies have no prior score. They are counted separately and never mixed
 * into the movers, where they would read as the greatest week of quality
 * improvement ever recorded.
 */

import { el, render } from './dom.js';
import { DASH, percent } from './format.js';

const signed = (n) => (n == null ? DASH : `${n > 0 ? '+' : ''}${n}`);

/**
 * @param {object} args
 * @param {HTMLElement} args.node
 * @param {object} args.data      the /api/score-movers payload, or {error}
 * @param {object} args.state     { range, direction }
 * @param {object} args.handlers  { onRange, onDirection, onSelectSymbol }
 */
export function renderMovers({ node, data, state, handlers }) {
  /*
   * The ranges come from the response rather than from a constant here.
   * lib/movers.js owns the list and the browser cannot import it, so the
   * choice is one definition arriving a beat late or two definitions
   * drifting apart. Late is the cheaper mistake, and the request is a
   * warehouse read that lands in about a tenth of a second.
   */
  const picker = el(
    'div',
    { class: 'segmented' },
    ...(data?.ranges ?? []).map((range) =>
      el('button', {
        type: 'button',
        text: range.label,
        'aria-pressed': String(state.range === range.key),
        onclick: () => handlers.onRange(range.key),
      }),
    ),
  );

  const head = el(
    'div',
    { class: 'card-head' },
    el('h2', { class: 'card-title', text: 'Score movers' }),
    picker,
  );

  if (!data) {
    render(node, head, el('p', { class: 'muted', text: 'Loading…' }));
    return;
  }

  if (data.error) {
    render(node, head, el('p', { class: 'error-note', text: data.error }));
    return;
  }

  /*
   * A range with no history behind it yet. Not an error and not an empty table:
   * the scores accumulate nightly, so this range starts working on its own, and
   * saying when is more use than a blank screen.
   */
  if (!data.available) {
    render(
      node,
      head,
      el('p', { class: 'empty-state', text: data.reason ?? 'Nothing to compare over this period yet.' }),
      data.oldest
        ? el('p', {
            class: 'muted',
            text:
              `Scoring began on ${data.oldest} and there ${data.covered === 1 ? 'is' : 'are'} ` +
              `${data.covered} snapshot${data.covered === 1 ? '' : 's'} on record. ` +
              `This range will fill in as the pipeline keeps running.`,
          })
        : null,
    );
    return;
  }

  const stat = (label, value, hint) =>
    el(
      'div',
      { class: 'income-stat' },
      el('span', { class: 'income-stat-label', text: label }),
      el('span', { class: 'income-stat-value', text: value }),
      hint ? el('span', { class: 'income-stat-hint', text: hint }) : null,
    );

  const summary = el(
    'div',
    { class: 'income-summary' },
    stat('Moved', String(data.counts.moved), `of ${data.scored} scored`),
    stat('Up', String(data.counts.up), 'improved'),
    stat('Down', String(data.counts.down), 'declined'),
    stat('Changed grade', String(data.counts.regraded), 'crossed a boundary'),
  );

  /*
   * Which record answered, said plainly.
   *
   * Two different things can fill this table and they are not interchangeable.
   * A recorded snapshot is what the pipeline actually wrote that day and moves
   * with price; a reconstruction is the score recomputed from statements, and
   * it only changes when a company reports. Reading one as the other is the
   * mistake this sentence exists to prevent, so it is above the table rather
   * than in a footnote under it.
   */
  const reconstructed = data.basis === 'reconstructed';
  const period = el('p', {
    class: 'muted',
    text:
      `${data.from} to ${data.to}` +
      (data.exact
        ? ''
        : ` — ${data.gapDays} days, not ${state.range.toUpperCase()}: nothing was scored on ${data.requested}, so the nearest earlier snapshot is used`) +
      `. ${data.counts.unchanged} scored on both dates and did not move` +
      (data.counts.newlyCovered
        ? `, and ${data.counts.newlyCovered} ${data.counts.newlyCovered === 1 ? 'was' : 'were'} not scored on ${data.from} at all, so ${data.counts.newlyCovered === 1 ? 'it is' : 'they are'} not counted as movers.`
        : '.'),
  });

  const basisNote = el('p', {
    class: 'muted',
    text: reconstructed
      ? `Reconstructed, not recorded: the pipeline has only been storing scores since ${data.oldest}, so both ends are recomputed — ${data.periodType} statements as they stood on each date, ` +
        `priced on that date. It is not the number that would have been on screen at the time, and it is less sensitive to price than the live score is: without the multiple ` +
        `measured against a company's own history and its peers, an already-expensive company stops scoring worse as it gets dearer, so this understates how much such a company moved.`
      : `Recorded: these are the scores the pipeline stored on each date, so the move includes everything that shifted them, price included.`,
  });

  const filters = el(
    'div',
    { class: 'segmented' },
    ...[
      ['all', 'All'],
      ['up', 'Up'],
      ['down', 'Down'],
      ['grade', 'Grade changes'],
    ].map(([key, label]) =>
      el('button', {
        type: 'button',
        text: label,
        'aria-pressed': String(state.direction === key),
        onclick: () => handlers.onDirection(key),
      }),
    ),
  );

  const shown = data.movers.filter((m) =>
    state.direction === 'up' ? m.change > 0
    : state.direction === 'down' ? m.change < 0
    : state.direction === 'grade' ? m.gradeChanged
    : true,
  );

  if (!shown.length) {
    /*
     * On a reconstructed range this is usually the honest answer rather than a
     * fault: a quarterly score only steps when a quarter closes, and over
     * thirty days almost nothing does. Saying "nothing moved" alone invites the
     * reader to conclude the view is broken.
     */
    const why =
      reconstructed && state.direction === 'all' && data.counts.moved === 0
        ? `Nothing moved between ${data.from} and ${data.to}: no company reported in that window and no price crossed a scoring threshold.`
        : 'Nothing moved that way over this period.';
    render(node, head, summary, period, basisNote, filters, el('p', { class: 'empty-state', text: why }));
    return;
  }

  const table = el(
    'table',
    { class: 'data dip-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        ...['Symbol', 'Company', 'Sector', 'Was', 'Now', 'Change', 'Grade', 'Share price'].map((label) =>
          el('th', { scope: 'col', text: label }),
        ),
      ),
    ),
    el(
      'tbody',
      {},
      ...shown.map((m) =>
        el(
          'tr',
          {},
          el(
            'th',
            { scope: 'row' },
            el('button', {
              class: 'link-button',
              type: 'button',
              text: m.symbol,
              onclick: () => handlers.onSelectSymbol(m.symbol),
            }),
          ),
          el('td', { class: 'muted', text: m.name }),
          el('td', { class: 'muted', text: m.sector ?? DASH }),
          el('td', { text: String(m.previousScore) }),
          el('td', { text: String(m.score) }),
          el('td', {
            class: m.change > 0 ? 'delta-up' : 'delta-down',
            text: signed(m.change),
          }),
          el('td', {
            text: m.gradeChanged ? `${m.previousGrade} → ${m.grade}` : m.grade,
            class: m.gradeChanged ? '' : 'muted',
          }),
          /*
           * What the shares did over the same window. Beside the score change
           * because the pair is the point: a grade falling while the price
           * climbed is a different story from both falling together, and
           * neither column tells it alone.
           */
          el('td', {
            class: m.priceChangePct == null ? 'muted' : m.priceChangePct > 0 ? 'delta-up' : 'delta-down',
            text:
              m.priceChangePct == null
                ? DASH
                : `${m.priceChangePct > 0 ? '+' : ''}${percent(m.priceChangePct)}`,
            title: m.priceUnmeasurable
              ? 'No price move to measure: this window contains only one close'
              : m.priceSplitAdjusted
                ? 'Corrected for a share split inside this window'
                : 'Share price movement over the same window, splits accounted for',
          }),
        ),
      ),
    ),
  );

  /*
   * Scores are usually fresher than prices: a scoring run lands before the next
   * close does. Over a one-day window that leaves both ends on the same
   * session, so there is no move to measure — which is a different thing from a
   * price that held still, and the column would otherwise read a confident zero
   * down every row.
   */
  const unpriced = shown.filter((m) => m.priceUnmeasurable).length;
  const priceNote =
    unpriced === shown.length && shown.length
      ? el('p', {
          class: 'muted',
          text:
            `No share price column over this window: the scores run to ${data.to} and the last close for these companies is ${data.from}, ` +
            `so both ends of the price comparison land on the same session. A longer range prices normally.`,
        })
      : null;

  render(node, head, summary, period, basisNote, filters, table, priceNote);
}
