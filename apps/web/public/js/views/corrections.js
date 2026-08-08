/**
 * Corrections — the score sheet, with its history.
 *
 * ---------------------------------------------------------------------------
 * A CORRECTION IS AN ORDINARY OPERATION, NOT AN ADMIN ESCAPE HATCH
 * ---------------------------------------------------------------------------
 * The arena reverses a call more often than software designers like to admit.
 * A judge's sheet turns up with 17.24 where the terminal has 17.42; a barrier
 * flag was missed; a time was read off the wrong lane. Somebody is usually
 * standing there while it gets sorted out.
 *
 * So this screen makes correcting easy and makes hiding it impossible. Every
 * change shows on the same row it changed, with who did it and why, and that
 * history cannot be shortened by anybody — the database appends it on any
 * UPDATE, including one made by going round this interface entirely.
 *
 * The reason is asked for every time. Not enforced at the database, because
 * refusing to save a fix at eleven at night over a missing sentence is worse
 * than an unexplained fix — but asked, every time.
 */

import { api } from '../api.js';
import { crumbs, h, render, showPrint, toast } from '../ui.js';

const STATUS_PILL = {
  official: 'pill ok',
  provisional: 'pill warn',
  dq: 'pill stop',
  reride: 'pill warn',
  no_time: 'pill',
  turned_out: 'pill',
  scratched: 'pill',
};

export async function correctionsView(rodeoId, eventId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  const event = rodeo.events.find((e) => e.id === eventId) ?? rodeo.events[0];

  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Corrections' },
  );

  if (!event) {
    render(h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No events.')));
    return;
  }

  const rows = await api.scoreSheet(rodeoId, event.id);

  async function correct(row) {
    const isTimed = event.scoring_mode === 'timed';
    const current = isTimed ? row.final_time : row.final_score;
    const typed = prompt(
      `${row.contestant_name} — corrected ${isTimed ? 'time' : 'score'}:`,
      current ?? '',
    );
    if (typed === null) return;
    const value = typed.trim() === '' ? null : Number(typed);
    if (value !== null && !Number.isFinite(value)) return toast('That is not a number.', true);

    const reason = prompt('Why? This goes on the record and cannot be removed.') ?? '';
    if (reason.trim().length < 3) return toast('A reason is required.', true);

    try {
      const out = await api.correctScore(rodeoId, row.score_id, {
        [isTimed ? 'final_time' : 'final_score']: value,
        reason: reason.trim(),
      });
      toast(out.next_step ?? 'Corrected.');
      correctionsView(rodeoId, event.id);
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function dq(row) {
    const reason = prompt(`Disqualify ${row.contestant_name}. Reason:`) ?? '';
    if (reason.trim().length < 3) return toast('A DQ needs a reason.', true);
    try {
      await api.dqScore(rodeoId, row.score_id, reason.trim());
      toast('Disqualified. Re-finalise the event.');
      correctionsView(rodeoId, event.id);
    } catch (err) { toast(err.message, true); }
  }

  async function reride(row) {
    const reason = prompt(`Re-ride for ${row.contestant_name}. Reason:`) ?? '';
    if (reason.trim().length < 3) return toast('A re-ride needs a reason.', true);
    try {
      await api.rerideScore(rodeoId, row.score_id, reason.trim());
      toast('Marked. Score the re-ride as a new run.');
      correctionsView(rodeoId, event.id);
    } catch (err) { toast(err.message, true); }
  }

  function historyOf(row) {
    const history = Array.isArray(row.edit_history) ? row.edit_history : [];
    if (history.length === 0) return null;
    return h('tr', {},
      h('td', { colspan: '6', class: 'small muted', style: 'padding-left:24px' },
        history.map((e) =>
          h('div', {},
            `${e.field.replace(/_/g, ' ')}: ${e.from ?? '—'} → ${e.to ?? '—'}`,
            e.reason ? `  ·  ${e.reason}` : '',
            e.at ? h('span', { class: 'muted' }, `  ${String(e.at).slice(0, 19).replace('T', ' ')}`) : null,
          ),
        ),
      ),
    );
  }

  const body = [];
  for (const row of rows) {
    body.push(
      h('tr', {},
        h('td', {}, row.contestant_name),
        h('td', {}, row.go_round > 1 ? `R${row.go_round}` : ''),
        h('td', {}, row.final_time ?? row.final_score ?? '—'),
        h('td', {}, h('span', { class: STATUS_PILL[row.status] ?? 'pill' }, row.status.replace(/_/g, ' '))),
        h('td', { class: 'small muted' },
          row.dq_reason ?? row.reride_reason ?? row.correction_reason ?? ''),
        h('td', { class: 'noprint' },
          ['provisional', 'official'].includes(row.status)
            ? h('div', { style: 'display:flex;gap:6px' },
                h('button', { class: 'ghost', onclick: () => correct(row) }, 'Correct'),
                h('button', { class: 'ghost', onclick: () => dq(row) }, 'DQ'),
                h('button', { class: 'ghost', onclick: () => reride(row) }, 'Re-ride'),
              )
            : null,
        ),
      ),
    );
    const history = historyOf(row);
    if (history) body.push(history);
  }

  render(
    h('div', {},
      h('h1', {}, 'Corrections'),
      h('p', { class: 'muted' }, `${rodeo.name}  ·  ${event.label ?? event.event_type}`),

      h('div', { class: 'actions noprint' },
        rodeo.events.map((e) =>
          h('a', {
            class: 'row-link',
            href: `#/rodeo/${rodeoId}/corrections/${e.id}`,
            style: `padding:10px 16px${e.id === event.id ? ';border-color:var(--accent)' : ''}`,
          }, e.label ?? e.event_type),
        ),
      ),

      h('div', { class: 'card small muted noprint' },
        'Every change below is recorded with who made it and why. That history '
        + 'is appended by the database on any update — including one made '
        + 'outside this screen — and it cannot be shortened.'),

      rows.length === 0
        ? h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Nothing scored yet.'))
        : h('div', { class: 'card sheet' },
            h('table', {},
              h('thead', {},
                h('tr', {},
                  h('th', {}, 'Contestant'), h('th', {}, 'Rd'),
                  h('th', {}, event.scoring_mode === 'timed' ? 'Time' : 'Score'),
                  h('th', {}, 'Status'), h('th', {}, 'Reason'), h('th', {}, ''),
                ),
              ),
              h('tbody', {}, body),
            ),
          ),

      h('div', { class: 'actions noprint' },
        h('button', {
          onclick: async () => {
            try {
              await api.finalize(rodeoId, event.id, true);
              toast('Re-finalised. Placings and payouts have moved.');
            } catch (err) { toast(err.message, true); }
          },
        }, 'Re-finalise this event'),
      ),
    ),
  );
}
