/**
 * Stock and personnel.
 *
 * Two screens that share a page because they answer the same question on the
 * morning of a rodeo: is everything here that has to be here.
 *
 * ---------------------------------------------------------------------------
 * The personnel half leads with the SHORTFALL, not the roster. A list of who
 * is booked is a thing to read; "you are one carded judge short and PRCA wants
 * two" is a thing to act on, and it is the one output of the credential
 * registry that justifies the registry existing.
 *
 * An unverified card counts for nothing. That is not pedantry — anybody can
 * type a number into a box, and a shortfall report that trusts typed numbers
 * will always say the rodeo is fine.
 */

import { api } from '../api.js';
import { crumbs, h, money, render, showPrint, toast } from '../ui.js';

const HEALTH_PILL = {
  active: 'pill ok',
  injured: 'pill stop',
  retired: 'pill',
  deceased: 'pill',
};

export async function arenaView(rodeoId) {
  showPrint(() => window.print());
  const [rodeo, animals, personnel] = await Promise.all([
    api.rodeo(rodeoId),
    api.animals(rodeoId).catch(() => []),
    api.personnel(rodeoId).catch(() => ({ assigned: [], shortfall: [] })),
  ]);

  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Stock & crew' },
  );

  // ---- Personnel ----------------------------------------------------------

  const shortfallBox = personnel.shortfall.length
    ? h('div', {},
        personnel.shortfall.map((s) =>
          h('div', { class: 'issue blocker' },
            h('div', { class: 'where' }, s.role.replace(/_/g, ' ')),
            h('div', {}, `${s.assigned} of ${s.required} assigned.`),
            h('div', { class: 'fix' },
              '→ Assign somebody, and check their card — an unverified card '
              + 'does not count towards the requirement.'),
          ),
        ))
    : h('div', { class: 'card' },
        h('p', { style: 'margin:0;color:var(--ok)' },
          rodeo.sanctioned_by.length
            ? '✓ Every role the sanctioning body requires is filled and carded.'
            : 'Nobody sanctions this rodeo, so nothing is required.'));

  const searchInput = h('input', {
    placeholder: 'Find somebody to work it',
    autocomplete: 'off',
    'aria-label': 'Find crew',
  });
  const roleSelect = h('select', {},
    ['judge', 'secretary', 'timer_operator', 'announcer', 'pickup_rider',
     'bullfighter', 'chute_boss', 'gate_puller', 'veterinarian']
      .map((r) => h('option', { value: r }, r.replace(/_/g, ' '))),
  );
  const searchResults = h('div', { class: 'rows' });

  let timer;
  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    const q = searchInput.value.trim();
    if (q.length < 3) return searchResults.replaceChildren();
    timer = setTimeout(async () => {
      const people = await api.people(q).catch(() => []);
      searchResults.replaceChildren(
        ...people.map((p) =>
          h('button', {
            type: 'button', class: 'row-link',
            style: 'text-align:left;background:var(--surface);color:inherit',
            onclick: async () => {
              try {
                await api.assignPersonnel(rodeoId, {
                  user_id: p.id, role: roleSelect.value,
                });
                toast(`${p.first_name} ${p.last_name} on as ${roleSelect.value.replace(/_/g, ' ')}.`);
                arenaView(rodeoId);
              } catch (err) { toast(err.message, true); }
            },
          }, h('div', {}, h('strong', {}, `${p.first_name} ${p.last_name}`))),
        ),
      );
    }, 180);
  });

  const crewTable = personnel.assigned.length
    ? h('table', { class: 'sheet' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Role'), h('th', {}, 'Name'), h('th', {}, 'Card'),
          h('th', {}, 'Fee'), h('th', {}, ''))),
        h('tbody', {},
          personnel.assigned.map((p) =>
            h('tr', {},
              h('td', {}, p.role.replace(/_/g, ' ')),
              h('td', {}, p.name),
              h('td', {},
                p.carded
                  ? h('span', { class: 'pill ok' },
                      p.card_number ? `#${p.card_number}` : 'carded')
                  : h('span', { class: 'pill warn' }, 'not carded'),
                p.card_expires
                  ? h('span', { class: 'muted small' }, `  to ${p.card_expires}`)
                  : null),
              h('td', {}, p.fee_cents ? money(Number(p.fee_cents)) : ''),
              h('td', { class: 'noprint' },
                h('button', {
                  class: 'ghost',
                  onclick: async () => {
                    try {
                      await api.removePersonnel(rodeoId, p.id);
                      toast('Removed.');
                      arenaView(rodeoId);
                    } catch (err) { toast(err.message, true); }
                  },
                }, 'Remove')),
            ),
          ),
        ),
      )
    : h('p', { class: 'muted' }, 'Nobody assigned yet.');

  // ---- Stock --------------------------------------------------------------

  const nameInput = h('input', { placeholder: 'Night Crawler', 'aria-label': 'Animal name' });
  const brandInput = h('input', { placeholder: '214', 'aria-label': 'Brand number' });
  const typeSelect = h('select', {},
    ['bull', 'saddle_bronc', 'bareback_bronc', 'calf', 'steer', 'horse', 'goat']
      .map((t) => h('option', { value: t }, t.replace(/_/g, ' '))),
  );

  async function addAnimal(e) {
    e.preventDefault();
    if (!nameInput.value.trim()) return toast('Give it a name.', true);
    try {
      await api.createAnimal({
        name: nameInput.value.trim(),
        animal_type: typeSelect.value,
        brand_number: brandInput.value.trim() || undefined,
      });
      toast('Added to the pen.');
      arenaView(rodeoId);
    } catch (err) { toast(err.message, true); }
  }

  const stockTable = animals.length
    ? h('table', { class: 'sheet' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Brand'), h('th', {}, 'Name'), h('th', {}, 'Type'),
          h('th', {}, 'Drawn'), h('th', {}, 'Health'), h('th', {}, ''))),
        h('tbody', {},
          animals.map((a) =>
            h('tr', { class: a.health_status === 'active' ? '' : 'scratched' },
              h('td', {}, a.brand_number ?? ''),
              h('td', {}, a.name),
              h('td', {}, a.animal_type.replace(/_/g, ' ')),
              h('td', {}, a.drawn_here || ''),
              h('td', {}, h('span', { class: HEALTH_PILL[a.health_status] ?? 'pill' },
                a.health_status)),
              h('td', { class: 'noprint' },
                a.health_status === 'active'
                  ? h('button', {
                      class: 'ghost',
                      onclick: async () => {
                        // Marking an animal injured takes it out of the draw
                        // pool, which is the point — a sore bull should not
                        // come up again on Sunday.
                        try {
                          await api.setAnimalHealth(a.id, 'injured');
                          toast(`${a.name} marked injured — out of the draw.`);
                          arenaView(rodeoId);
                        } catch (err) { toast(err.message, true); }
                      },
                    }, 'Mark injured')
                  : h('button', {
                      class: 'ghost',
                      onclick: async () => {
                        try {
                          await api.setAnimalHealth(a.id, 'active');
                          arenaView(rodeoId);
                        } catch (err) { toast(err.message, true); }
                      },
                    }, 'Back in')),
            ),
          ),
        ),
      )
    : h('p', { class: 'muted' }, 'No stock recorded.');

  render(
    h('div', {},
      h('h1', {}, 'Stock & crew'),
      h('p', { class: 'muted' }, rodeo.name),

      h('h2', {}, 'Who has to be here'),
      shortfallBox,

      h('div', { class: 'card noprint' },
        h('h3', { style: 'margin-top:0' }, 'Add crew'),
        h('div', { class: 'grid2' },
          h('label', {}, 'Role', roleSelect),
          h('label', {}, 'Who', searchInput),
        ),
        searchResults,
      ),

      h('div', { class: 'card sheet' }, crewTable),

      h('h2', {}, 'Stock'),
      h('form', { class: 'card noprint', onsubmit: addAnimal },
        h('div', { class: 'grid2' },
          h('label', {}, 'Name', nameInput),
          h('label', {}, 'Brand', brandInput),
        ),
        h('label', {}, 'Type', typeSelect),
        h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Add to the pen')),
      ),
      h('div', { class: 'card sheet' }, stockTable),
    ),
  );
}
