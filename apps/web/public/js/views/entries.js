/**
 * The entry desk.
 *
 * ---------------------------------------------------------------------------
 * THERE IS A QUEUE OF PEOPLE STANDING IN FRONT OF THIS SCREEN.
 * ---------------------------------------------------------------------------
 * That is the only design constraint that matters here. Everything is built
 * around one loop, repeated fifty times in twenty minutes:
 *
 *   type three letters of a surname → pick the person → pick events →
 *   pick a horse → take the money → next
 *
 * So: the search box has focus on load and regains it after every entry, the
 * results appear as you type, and a person who has entered here before sorts
 * to the top. Nothing modal, nothing that needs a mouse, no confirmation
 * dialog between one contestant and the next.
 *
 * The person search is GLOBAL — see the note in desk-repo.ts. Matching an
 * existing roper instead of typing a new one is what stops the same person
 * existing five times, and duplicates are what destroy the career record.
 */

import { api } from '../api.js';
import { crumbs, h, money, render, showPrint, toast } from '../ui.js';

const OUT = new Set(['scratched', 'turned_out', 'no_show']);

export async function entriesView(rodeoId) {
  showPrint(() => window.print());
  const [rodeo, entries] = await Promise.all([
    api.rodeo(rodeoId),
    api.entries(rodeoId),
  ]);

  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Entries' },
  );

  const state = { person: null, events: new Set(), horse: null, partner: null };

  const searchInput = h('input', {
    placeholder: 'Surname, or a phone number',
    autocomplete: 'off',
    'aria-label': 'Find a contestant',
  });
  const resultBox = h('div', { class: 'rows' });
  const pickedBox = h('div');
  const eventBox = h('div', { class: 'pick' });
  const horseBox = h('div');
  const quoteBox = h('div', { class: 'muted' });

  // ---- Person search ------------------------------------------------------

  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) return resultBox.replaceChildren();
    // Debounced, because this fires on every keystroke while somebody waits.
    searchTimer = setTimeout(async () => {
      try {
        const people = await api.people(q);
        resultBox.replaceChildren(
          ...people.map((p) =>
            h('button', {
              type: 'button',
              class: 'row-link',
              style: 'text-align:left;background:var(--surface);color:inherit;border-color:var(--line)',
              onclick: () => pick(p),
            },
              h('div', {},
                h('strong', {}, `${p.first_name} ${p.last_name}`),
                h('span', { class: 'muted small' },
                  [[p.city, p.state_province].filter(Boolean).join(', '),
                   p.known_here ? `${p.entries_here} entries here` : 'new to you',
                  ].filter(Boolean).join('  ·  ')),
              ),
              p.known_here ? h('span', { class: 'pill ok' }, 'known') : null,
            ),
          ),
          h('button', {
            type: 'button', class: 'row-link',
            style: 'text-align:left;background:transparent;color:inherit;border-style:dashed',
            onclick: () => createPerson(q),
          }, `+ Nobody matches — add "${q}"`),
        );
      } catch (err) {
        toast(err.message, true);
      }
    }, 180);
  });

  async function createPerson(typed) {
    // Split on the last space: "Casey Roper" and "Mary Jo Baker" both work.
    const parts = typed.trim().split(/\s+/);
    const last = parts.length > 1 ? parts.pop() : '';
    const first = parts.join(' ');
    const firstName = prompt('First name:', first || typed) ?? '';
    if (!firstName.trim()) return;
    const lastName = prompt('Last name:', last) ?? '';
    if (!lastName.trim()) return;
    try {
      const person = await api.createPerson({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
      });
      toast(`${person.first_name} ${person.last_name} added.`);
      pick(person);
    } catch (err) {
      toast(err.message, true);
    }
  }

  function pick(person) {
    state.person = person;
    state.horse = null;
    resultBox.replaceChildren();
    searchInput.value = '';
    drawPicked();
    drawHorse();
    quote();
  }

  function drawPicked() {
    pickedBox.replaceChildren(
      state.person
        ? h('div', { class: 'card' },
            h('h3', { style: 'margin:0' },
              `${state.person.first_name} ${state.person.last_name}`),
            h('div', { class: 'muted small' },
              [[state.person.city, state.person.state_province].filter(Boolean).join(', '),
               state.person.known_here ? `${state.person.entries_here} entries with you` : 'first time here',
              ].filter(Boolean).join('  ·  ')),
            h('div', { class: 'actions' },
              h('a', { class: 'row-link', style: 'padding:8px 14px',
                       href: `#/contestant/${state.person.id}` }, 'Career'),
              h('button', { class: 'ghost', onclick: () => { state.person = null; drawPicked(); searchInput.focus(); } },
                'Change'),
            ))
        : h('p', { class: 'muted' }, 'Nobody selected yet.'),
    );
  }

  // ---- Events -------------------------------------------------------------

  for (const ev of rodeo.events) {
    eventBox.append(
      h('label', {},
        h('input', {
          type: 'checkbox',
          onchange: (e) => {
            if (e.target.checked) state.events.add(ev.id);
            else state.events.delete(ev.id);
            quote();
          },
        }),
        ev.label ?? ev.event_type,
        h('span', { class: 'muted small' }, `  ${money(Math.round(Number(ev.entry_fee) * 100))}`),
      ),
    );
  }

  // ---- Horse --------------------------------------------------------------

  const horseInput = h('input', {
    placeholder: 'Barn name — leave blank if none',
    autocomplete: 'off',
    'aria-label': 'Horse',
  });
  const horseResults = h('div', { class: 'rows' });

  let horseTimer;
  horseInput.addEventListener('input', () => {
    clearTimeout(horseTimer);
    const q = horseInput.value.trim();
    if (q.length < 2) return horseResults.replaceChildren();
    horseTimer = setTimeout(async () => {
      const rows = await api.registrySearch(q, 'horse').catch(() => []);
      horseResults.replaceChildren(
        ...rows.map((r) =>
          h('button', {
            type: 'button', class: 'row-link',
            style: 'text-align:left;background:var(--surface);color:inherit',
            onclick: () => { state.horse = r; horseInput.value = r.barn_name; horseResults.replaceChildren(); },
          },
            h('div', {},
              h('strong', {}, r.barn_name),
              r.registered_name ? h('span', { class: 'muted small' }, r.registered_name) : null),
          ),
        ),
        h('button', {
          type: 'button', class: 'row-link',
          style: 'text-align:left;background:transparent;color:inherit;border-style:dashed',
          onclick: async () => {
            try {
              const created = await api.createRegistryAnimal({ barn_name: q, animal_type: 'horse' });
              state.horse = created;
              horseInput.value = created.barn_name;
              horseResults.replaceChildren();
              toast(`${created.barn_name} added to the registry.`);
            } catch (err) { toast(err.message, true); }
          },
        }, `+ Add "${q}" to the registry`),
      );
    }, 180);
  });

  function drawHorse() {
    horseInput.value = '';
    horseResults.replaceChildren();
    horseBox.replaceChildren(
      h('label', {}, 'Horse',
        h('span', { class: 'hint' },
          'Matching an existing horse is what gives it a career record.'),
        horseInput),
      horseResults,
    );
  }

  // ---- Quote --------------------------------------------------------------

  async function quote() {
    if (!state.person || state.events.size === 0) {
      quoteBox.replaceChildren('Pick a contestant and at least one event.');
      return;
    }
    let total = 0;
    for (const id of state.events) {
      const ev = rodeo.events.find((e) => e.id === id);
      total += Math.round(Number(ev?.entry_fee ?? 0) * 100);
    }
    quoteBox.replaceChildren(
      h('strong', {}, money(total)),
      ` for ${state.events.size} event${state.events.size === 1 ? '' : 's'}`,
    );
  }

  // ---- Take the entry -----------------------------------------------------

  async function takeEntry(paid) {
    if (!state.person) return toast('Pick a contestant.', true);
    if (state.events.size === 0) return toast('Pick at least one event.', true);

    const ok = [];
    const failed = [];
    for (const eventId of state.events) {
      try {
        await api.enter(rodeoId, eventId, {
          contestant_id: state.person.id,
          horse_id: state.horse?.id,
          payment_method: paid ? 'cash' : undefined,
        });
        ok.push(eventId);
      } catch (err) {
        failed.push(`${rodeo.events.find((e) => e.id === eventId)?.label ?? 'event'}: ${err.message}`);
      }
    }

    if (failed.length) toast(failed.join(' · '), true);
    if (ok.length) toast(`${state.person.first_name} entered in ${ok.length}.`);

    // Straight back to the search box for the next person in the queue.
    state.person = null;
    state.horse = null;
    for (const box of eventBox.querySelectorAll('input')) box.checked = false;
    state.events.clear();
    drawPicked();
    drawHorse();
    quote();
    await refreshList();
    searchInput.focus();
  }

  // ---- The books ----------------------------------------------------------

  const listBox = h('div');

  async function refreshList() {
    const rows = await api.entries(rodeoId);
    drawList(rows);
  }

  function drawList(rows) {
    const live = rows.filter((r) => !OUT.has(r.status));
    const unpaid = live.filter((r) => !r.fees_paid);

    listBox.replaceChildren(
      h('h2', {}, 'The books',
        h('span', { class: 'muted small' },
          `   ${live.length} in, ${unpaid.length} unpaid`)),
      rows.length === 0
        ? h('p', { class: 'muted' }, 'Nothing entered yet.')
        : h('div', { class: 'card sheet' },
            h('table', {},
              h('thead', {},
                h('tr', {},
                  h('th', {}, 'Back'),
                  h('th', {}, 'Contestant'),
                  h('th', {}, 'Event'),
                  h('th', {}, 'Horse'),
                  h('th', {}, 'Fee'),
                  h('th', {}, ''),
                ),
              ),
              h('tbody', {},
                rows.map((r) =>
                  h('tr', { class: OUT.has(r.status) ? 'scratched' : '' },
                    h('td', {}, r.back_number ?? ''),
                    h('td', {}, r.contestant_name,
                      r.partner_name ? h('span', { class: 'muted small' }, ` / ${r.partner_name}`) : null),
                    h('td', {}, r.event_label),
                    h('td', {}, r.horse_name ?? ''),
                    h('td', {}, r.entry_fee_amount ? money(Math.round(Number(r.entry_fee_amount) * 100)) : ''),
                    h('td', { class: 'flagcell noprint' },
                      OUT.has(r.status)
                        ? h('span', { class: 'pill' }, r.status.replace(/_/g, ' '))
                        : h('button', {
                            class: r.fees_paid ? 'ghost' : '',
                            onclick: async () => {
                              try {
                                await api.patchEntry(rodeoId, r.entry_id, { fees_paid: !r.fees_paid });
                                refreshList();
                              } catch (err) { toast(err.message, true); }
                            },
                          }, r.fees_paid ? 'Paid' : 'Take payment'),
                    ),
                  ),
                ),
              ),
            ),
          ),
    );
  }

  drawList(entries);
  drawPicked();
  drawHorse();
  quote();

  render(
    h('div', {},
      h('h1', {}, 'Entries'),
      h('p', { class: 'muted' }, rodeo.name),

      h('div', { class: 'card noprint' },
        h('h2', { style: 'margin-top:0' }, 'Take an entry'),
        h('label', {}, 'Who',
          h('span', { class: 'hint' },
            'Searches every contestant on the platform, not just yours — '
            + 'matching an existing one keeps their record in one piece.'),
          searchInput),
        resultBox,
        pickedBox,
        h('label', {}, 'Events'),
        eventBox,
        horseBox,
        h('div', { class: 'card', style: 'margin-top:14px' }, quoteBox),
        h('div', { class: 'actions' },
          h('button', { onclick: () => takeEntry(true) }, 'Enter — paid'),
          h('button', { class: 'ghost', onclick: () => takeEntry(false) }, 'Enter — owes'),
        ),
      ),

      h('div', { class: 'actions noprint' },
        h('button', {
          class: 'ghost',
          onclick: async () => {
            try {
              const rows = await api.assignBackNumbers(rodeoId);
              toast(`${rows.length} back numbers out.`);
              refreshList();
            } catch (err) { toast(err.message, true); }
          },
        }, 'Hand out back numbers'),
        h('a', { class: 'row-link', style: 'padding:10px 16px', href: `#/rodeo/${rodeoId}/draw` },
          'Run the draw →'),
      ),

      listBox,
    ),
  );

  searchInput.focus();
}
