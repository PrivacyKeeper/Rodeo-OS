/**
 * A contestant's career.
 *
 * ---------------------------------------------------------------------------
 * The page nobody in this sport currently has. A cowboy's earnings live in an
 * association's standings, a barrel series spreadsheet, a jackpot's Facebook
 * post and a shoebox, and no screen anywhere adds them up.
 *
 * Two rules on this page:
 *
 * 1. It says where every run came from. A run written from official results at
 *    a rodeo on this platform is not the same kind of fact as one the
 *    contestant typed in themselves, and pretending otherwise would make the
 *    whole record worthless.
 *
 * 2. What comes back is decided by the database, not by this file. A
 *    contestant reading their own id gets everything; a secretary reading
 *    somebody else's gets only what happened at her own rodeos. There is no
 *    filtering here to get wrong.
 */

import { api } from '../api.js';
import { crumbs, h, money, render, showPrint } from '../ui.js';

const SOURCE_LABEL = {
  platform: 'Official',
  imported: 'Imported',
  self_reported: 'Self-reported',
};

export async function contestantView(contestantId) {
  showPrint(() => window.print());
  crumbs({ label: 'Rodeos', href: '#/' }, { label: 'Career' });

  const career = await api.career(contestantId);
  const runs = career.runs;

  const seasons = new Map();
  for (const row of career.by_season) {
    const bucket = seasons.get(row.season) ?? [];
    bucket.push(row);
    seasons.set(row.season, bucket);
  }

  render(
    h('div', {},
      h('h1', {}, 'Career'),
      h('p', { class: 'muted' },
        `${runs.length} runs  ·  ${money(career.total_earnings_cents)} earned  ·  `
        + `${career.verified_runs} verified`),

      runs.length === 0
        ? h('div', { class: 'card' },
            h('p', { class: 'muted' },
              'Nothing recorded yet — or nothing you are allowed to see. A '
              + 'secretary sees only the runs made at her own rodeos.'))
        : h('div', {},
            h('h2', {}, 'By season'),
            h('div', { class: 'card' },
              h('table', { class: 'ledger' },
                h('tbody', {},
                  [...seasons.entries()].map(([season, rows]) => [
                    h('tr', {},
                      h('td', {}, h('strong', {}, season)),
                      h('td', {},
                        money(rows.reduce((t, r) => t + Number(r.earnings_cents), 0))),
                    ),
                    ...rows.map((r) =>
                      h('tr', { class: 'sub' },
                        h('td', {}, `   ${r.event_code.replace(/_/g, ' ')} · ${r.runs} runs`),
                        h('td', {}, money(Number(r.earnings_cents))),
                      ),
                    ),
                  ]),
                ),
              ),
            ),

            h('h2', {}, 'Every run'),
            h('div', { class: 'card sheet' },
              h('table', {},
                h('thead', {},
                  h('tr', {},
                    h('th', {}, 'Date'), h('th', {}, 'Rodeo'), h('th', {}, 'Event'),
                    h('th', {}, 'Horse'), h('th', {}, 'Place'),
                    h('th', { style: 'text-align:right' }, 'Won'),
                    h('th', {}, 'Source'),
                  ),
                ),
                h('tbody', {},
                  runs.map((r) =>
                    h('tr', {},
                      h('td', {}, r.run_date),
                      h('td', {}, r.rodeo_name,
                        [r.venue_city, r.venue_state].filter(Boolean).length
                          ? h('span', { class: 'muted small' },
                              `  ${[r.venue_city, r.venue_state].filter(Boolean).join(', ')}`)
                          : null),
                      h('td', {}, r.event_code.replace(/_/g, ' ')),
                      h('td', {}, r.animal_name ?? ''),
                      h('td', { class: 'pos' }, r.place ?? ''),
                      h('td', { style: 'text-align:right' }, money(Number(r.earnings_cents))),
                      h('td', {},
                        h('span', {
                          class: r.is_verified ? 'pill ok' : 'pill warn',
                        }, SOURCE_LABEL[r.source] ?? r.source),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}
