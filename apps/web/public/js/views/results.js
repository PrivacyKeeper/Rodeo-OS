/**
 * Results — and the moment they become real.
 *
 * ---------------------------------------------------------------------------
 * Publishing is one action per event, deliberately. Half a published event is
 * worse than an unpublished one: a contestant seeing the go-round but not the
 * average, or three placings out of six, will ring the secretary, and she is
 * the one person at a rodeo with no spare time.
 *
 * Making an event official is also what makes it visible to the public
 * scoreboard, to the nine apps, and to season standings — so the button says
 * so, rather than leaving somebody to discover it.
 */

import { api } from '../api.js';
import { crumbs, h, money, render, showPrint, toast } from '../ui.js';

const TYPE_LABEL = {
  go_round: 'Go-round',
  average: 'Average',
  aggregate: 'Aggregate',
  d_division: 'Division',
  day_money: 'Day money',
  overall: 'Overall',
};

export async function resultsView(rodeoId) {
  showPrint(() => window.print());
  const [rodeo, rows] = await Promise.all([api.rodeo(rodeoId), api.results(rodeoId)]);

  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Results' },
  );

  const byEvent = new Map();
  for (const r of rows) {
    const bucket = byEvent.get(r.rodeo_event_id) ?? [];
    bucket.push(r);
    byEvent.set(r.rodeo_event_id, bucket);
  }

  const sections = rodeo.events.map((ev) => {
    const evRows = byEvent.get(ev.id) ?? [];
    const official = evRows.length > 0 && evRows.every((r) => r.is_official);
    const anyProvisional = evRows.some((r) => !r.is_official);

    // Grouped by result type and round so the average never sits between two
    // go-rounds on the page.
    const groups = new Map();
    for (const r of evRows) {
      const key = `${r.result_type}:${r.go_round ?? ''}:${r.d_division ?? ''}`;
      const bucket = groups.get(key) ?? { rows: [], row: r };
      bucket.rows.push(r);
      groups.set(key, bucket);
    }

    return h('section', { class: 'card' },
      h('h2', {},
        ev.label ?? ev.event_type,
        official
          ? h('span', { class: 'pill ok', style: 'margin-left:10px' }, 'Official')
          : evRows.length
            ? h('span', { class: 'pill warn', style: 'margin-left:10px' }, 'Provisional')
            : null,
      ),

      evRows.length === 0
        ? h('p', { class: 'muted' },
            'Nothing placed yet. Score the runs, then compute the placings.')
        : h('div', {},
            [...groups.values()].map(({ rows: group, row }) =>
              h('div', {},
                h('h3', {},
                  TYPE_LABEL[row.result_type] ?? row.result_type,
                  row.go_round ? ` — Round ${row.go_round}` : '',
                  row.d_division ? ` — ${row.d_division}D` : ''),
                h('table', { class: 'sheet' },
                  h('thead', {}, h('tr', {},
                    h('th', {}, '#'), h('th', {}, 'Contestant'),
                    h('th', {}, 'Score'),
                    h('th', { style: 'text-align:right' }, 'Won'),
                    h('th', { style: 'text-align:right' }, 'Points'))),
                  h('tbody', {},
                    group
                      .slice()
                      .sort((a, b) => (a.place ?? 999) - (b.place ?? 999))
                      .map((r) =>
                        h('tr', {},
                          h('td', { class: 'pos' }, r.place ?? '—'),
                          h('td', {}, r.contestant_name),
                          h('td', {}, r.aggregate_score ?? ''),
                          h('td', { style: 'text-align:right' },
                            money(Math.round(Number(r.payout_amount) * 100))),
                          h('td', { style: 'text-align:right' }, r.points_earned),
                        ),
                      ),
                  ),
                ),
              ),
            ),

            h('div', { class: 'actions noprint' },
              anyProvisional
                ? h('button', {
                    onclick: async () => {
                      try {
                        const out = await api.publishResults(rodeoId, ev.id, true);
                        toast(`${out.updated} placings are now official and public.`);
                        resultsView(rodeoId);
                      } catch (err) { toast(err.message, true); }
                    },
                  }, 'Publish — this makes them public')
                : h('button', {
                    class: 'ghost',
                    onclick: async () => {
                      if (!confirm('Pull these back? They will disappear from the public scoreboard and the apps.')) return;
                      try {
                        await api.publishResults(rodeoId, ev.id, false);
                        toast('Pulled back to provisional.');
                        resultsView(rodeoId);
                      } catch (err) { toast(err.message, true); }
                    },
                  }, 'Unpublish'),
              h('a', {
                class: 'row-link', style: 'padding:10px 16px',
                href: `#/rodeo/${rodeoId}/corrections/${ev.id}`,
              }, 'Corrections'),
            ),
          ),
    );
  });

  render(
    h('div', {},
      h('h1', {}, 'Results'),
      h('p', { class: 'muted' }, rodeo.name),
      h('div', { class: 'card small muted noprint' },
        'Publishing an event makes its placings visible on the public '
        + 'scoreboard, in the apps, and in season standings — all at once, so '
        + 'nobody sees half an event.'),
      sections,
    ),
  );
}
