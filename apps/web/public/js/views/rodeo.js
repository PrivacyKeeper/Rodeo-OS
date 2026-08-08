/**
 * The rodeo home screen and the list that leads to it.
 *
 * The list is the first thing a secretary sees, so it answers the question she
 * actually has — what still needs doing — rather than showing a table of
 * names and dates.
 */

import { api } from '../api.js';
import { crumbs, dateRange, h, render, showPrint, toast } from '../ui.js';

function stateLabel(rodeo) {
  if (rodeo.book_state === 'filed') return h('span', { class: 'pill ok' }, 'Filed');
  if (rodeo.book_state === 'closed') return h('span', { class: 'pill ok' }, 'Books closed');
  if (rodeo.book_state === 'reopened') return h('span', { class: 'pill warn' }, 'Reopened');
  if (rodeo.status === 'in_progress') return h('span', { class: 'pill warn' }, 'Running');
  if (rodeo.status === 'draft') return h('span', { class: 'pill' }, 'Draft');
  return h('span', { class: 'pill' }, rodeo.status.replace(/_/g, ' '));
}

export async function listView() {
  crumbs({ label: 'Rodeos' });
  showPrint(null);

  const rodeos = await api.rodeos();

  render(
    h('div', {},
      h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-end;gap:16px' },
        h('div', {},
          h('h1', {}, 'Rodeos'),
          h('p', { class: 'muted' }, `${rodeos.length} on the books`),
        ),
        h('a', { class: 'row-link', href: '#/new', style: 'padding:12px 20px' }, '+ New rodeo'),
      ),

      rodeos.length === 0
        ? h('div', { class: 'card' },
            h('h2', {}, 'Nothing here yet'),
            h('p', { class: 'muted' },
              'Set one up. A jackpot takes about a minute.'))
        : h('div', { class: 'rows', style: 'margin-top:18px' },
            rodeos.map((r) =>
              h('a', { class: 'row-link', href: `#/rodeo/${r.id}` },
                h('div', {},
                  h('strong', {}, r.name),
                  h('span', { class: 'muted small' },
                    [dateRange(r.start_date, r.end_date),
                     [r.venue_city, r.venue_state].filter(Boolean).join(', '),
                     `${r.event_count} events`,
                     `${r.entry_count} entries`,
                     r.sanctioned_by.length ? r.sanctioned_by.join(' · ') : 'Open',
                    ].filter(Boolean).join('  ·  ')),
                ),
                stateLabel(r),
              ),
            ),
          ),
    ),
  );
}

export async function rodeoView(id) {
  showPrint(null);
  const [rodeo, books] = await Promise.all([
    api.rodeo(id),
    api.books(id).catch(() => null),
  ]);

  crumbs({ label: 'Rodeos', href: '#/' }, { label: rodeo.name });

  const blockers = books?.blockers?.length ?? 0;
  const sanctioned = rodeo.sanctioned_by.length > 0;

  render(
    h('div', {},
      h('h1', {}, rodeo.name),
      h('p', { class: 'muted' },
        [dateRange(rodeo.start_date, rodeo.end_date),
         [rodeo.venue_city, rodeo.venue_state].filter(Boolean).join(', '),
         sanctioned ? rodeo.sanctioned_by.join(' · ') : 'Open — no sanctioning',
        ].filter(Boolean).join('  ·  ')),

      h('div', { class: 'rows', style: 'margin-top:18px' },
        // In the order a rodeo actually happens.
        h('a', { class: 'row-link', href: `#/rodeo/${id}/entries` },
          h('div', {},
            h('strong', {}, 'Entries'),
            h('span', { class: 'muted small' },
              'Take an entry, hand out back numbers, take the money'),
          ),
          h('span', { class: 'pill' }, `${rodeo.entry_count}`),
        ),
        h('a', { class: 'row-link', href: `#/rodeo/${id}/draw` },
          h('div', {},
            h('strong', {}, 'Draw'),
            h('span', { class: 'muted small' },
              'Seeded and reproducible — publish the seed and nobody can argue'),
          ),
        ),
        h('a', { class: 'row-link', href: `#/rodeo/${id}/daysheet` },
          h('div', {},
            h('strong', {}, 'Day sheet'),
            h('span', { class: 'muted small' }, 'Run order, stock, drags — the page the arena runs on'),
          ),
          h('span', { class: 'pill' }, `${rodeo.performances.length || 1} perf`),
        ),
        h('a', { class: 'row-link', href: `#/rodeo/${id}/scoring` },
          h('div', {},
            h('strong', {}, 'Scoring'),
            h('span', { class: 'muted small' },
              rodeo.events.map((e) => `${e.label ?? e.event_type}: ${e.scored}/${e.entries}`).join('  ·  ')),
          ),
        ),
        h('a', { class: 'row-link', href: `#/rodeo/${id}/payouts` },
          h('div', {},
            h('strong', {}, 'Payouts'),
            h('span', { class: 'muted small' }, 'Calculate, check it, then disburse'),
          ),
        ),
        h('a', { class: 'row-link', href: `#/rodeo/${id}/books` },
          h('div', {},
            h('strong', {}, 'Close the books'),
            h('span', { class: 'muted small' },
              books
                ? (books.ready ? 'Ready to close' : `${blockers} thing${blockers === 1 ? '' : 's'} to fix first`)
                : 'Settlement and filing'),
          ),
          books
            ? h('span', { class: books.ready ? 'pill ok' : 'pill stop' },
                books.ready ? 'Ready' : String(blockers))
            : null,
        ),
        // Shown only when somebody sanctions this rodeo. A jackpot never sees
        // it, which is the whole design rule of the sanction layer.
        sanctioned
          ? h('a', { class: 'row-link', href: `#/rodeo/${id}/compliance` },
              h('div', {},
                h('strong', {}, 'Sanctioning'),
                h('span', { class: 'muted small' }, 'Filings, insurance, escrow, carded personnel'),
              ))
          : null,
      ),

      h('h2', {}, 'Events'),
      h('div', { class: 'card' },
        h('table', { class: 'ledger' },
          h('tbody', {},
            rodeo.events.map((e) =>
              h('tr', {},
                h('td', {}, e.label ?? e.event_type,
                  h('span', { class: 'muted small' },
                    `  ${e.scoring_mode}${e.num_go_rounds > 1 ? ` · ${e.num_go_rounds} rounds` : ''}`)),
                h('td', {}, `${e.entries} entered`),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
