/**
 * Setting up a rodeo — five questions.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS SCREEN EXISTS TO OBEY
 * ---------------------------------------------------------------------------
 * A Tuesday-night jackpot must be set up in under a minute and must never be
 * asked a question a Tuesday-night jackpot does not have an answer to. The
 * same screen has to set up a three-performance sanctioned rodeo, and it does
 * it by asking ONE more question — who sanctions it — and letting everything
 * else follow from the answer.
 *
 * Every list on this page is data from `reference_options` and `associations`.
 * There is not one hard-coded event type in this file. A producer who added
 * wild cow milking sees wild cow milking here, and nobody deployed anything.
 */

import { api } from '../api.js';
import { field, h, render, select, toast, crumbs, showPrint } from '../ui.js';

/** Sensible slates so the common cases are two clicks, not twelve. */
const PRESETS = {
  rodeo: ['bareback', 'steer_wrestling', 'team_roping_header', 'saddle_bronc',
          'tie_down_roping', 'breakaway_roping', 'barrel_racing', 'bull_riding'],
  jackpot: ['team_roping_header'],
  barrel_race: ['barrel_racing'],
  roping: ['team_roping_header', 'breakaway_roping'],
  youth: ['barrel_racing', 'pole_bending', 'goat_tying', 'breakaway_roping'],
};

export async function setupView() {
  crumbs({ label: 'Rodeos', href: '#/' }, { label: 'New' });
  showPrint(null);

  const [options, associations] = await Promise.all([
    api.options(),
    api.associations(),
  ]);

  const eventOptions = (options.event_type ?? []).flatMap((g) => g.options);
  const rodeoTypes = (options.rodeo_type ?? []).flatMap((g) => g.options);

  const state = {
    events: new Map(), // code -> { entry_fee, added_money }
    sanctioning: new Set(),
  };

  const today = new Date().toISOString().slice(0, 10);

  const nameInput = h('input', { name: 'name', required: true, placeholder: 'Ada Roundup' });
  const startInput = h('input', { name: 'start', type: 'date', value: today });
  const endInput = h('input', { name: 'end', type: 'date', value: today });
  const cityInput = h('input', { name: 'city', placeholder: 'Ada' });
  const stateInput = h('input', { name: 'state', placeholder: 'OK', maxlength: 2 });
  const perfInput = h('input', { name: 'perfs', type: 'number', min: '1', max: '60', value: '1' });
  const roundsInput = h('input', { name: 'rounds', type: 'number', min: '1', max: '20', value: '1' });

  const feeBox = h('div', { class: 'feegrid' });
  const sanctionNote = h('div', { class: 'small muted' });
  const eventBox = h('div', { class: 'pick' });

  function redrawFees() {
    feeBox.replaceChildren();
    if (state.events.size === 0) {
      feeBox.append(h('div', { class: 'muted' }, 'Pick an event or two above first.'));
      return;
    }
    feeBox.append(
      h('div', { class: 'head' }, 'Event'),
      h('div', { class: 'head' }, 'Entry fee'),
      h('div', { class: 'head' }, 'Added money'),
    );
    for (const [code, cfg] of state.events) {
      const label = eventOptions.find((o) => o.code === code)?.label ?? code;
      feeBox.append(
        h('div', {}, label),
        h('input', {
          type: 'number', min: '0', step: '1', value: String(cfg.entry_fee),
          'aria-label': `${label} entry fee`,
          oninput: (e) => { cfg.entry_fee = Number(e.target.value || 0); },
        }),
        h('input', {
          type: 'number', min: '0', step: '1', value: String(cfg.added_money),
          'aria-label': `${label} added money`,
          oninput: (e) => { cfg.added_money = Number(e.target.value || 0); },
        }),
      );
    }
  }

  function toggleEvent(code, on) {
    if (on) state.events.set(code, { entry_fee: 50, added_money: 0 });
    else state.events.delete(code);
    redrawFees();
  }

  function drawEvents(highlight = []) {
    eventBox.replaceChildren();
    for (const opt of eventOptions) {
      const on = state.events.has(opt.code);
      const box = h('input', {
        type: 'checkbox',
        checked: on ? true : null,
        onchange: (e) => toggleEvent(opt.code, e.target.checked),
      });
      eventBox.append(
        h('label', { title: opt.description ?? '' }, box, opt.label,
          highlight.includes(opt.code) ? h('span', { class: 'muted small' }, ' ·') : null),
      );
    }
  }

  function applyPreset(type) {
    const preset = PRESETS[type];
    if (!preset) return;
    state.events.clear();
    for (const code of preset) {
      if (eventOptions.some((o) => o.code === code)) {
        state.events.set(code, { entry_fee: 50, added_money: 0 });
      }
    }
    drawEvents();
    redrawFees();
  }

  const typeSelect = select(
    'rodeo_type',
    rodeoTypes.map((o) => ({ value: o.code, label: o.label })),
    'jackpot',
    (e) => applyPreset(e.target.value),
  );

  // ---- Sanctioning -------------------------------------------------------
  // Everything downstream hangs off this one answer: the rules, the deduction,
  // the filing deadline, and whether a compliance calendar exists at all.
  const sanctionBox = h('div', { class: 'pick' });
  for (const a of associations.filter((x) => x.code !== 'OPEN')) {
    sanctionBox.append(
      h('label', {},
        h('input', {
          type: 'checkbox',
          onchange: (e) => {
            if (e.target.checked) state.sanctioning.add(a.code);
            else state.sanctioning.delete(a.code);
            describeSanctioning();
          },
        }),
        a.short_name ?? a.code,
        a.is_verified ? null : h('span', { class: 'muted small' }, ' (unverified)'),
      ),
    );
  }

  function describeSanctioning() {
    sanctionNote.replaceChildren();
    if (state.sanctioning.size === 0) {
      sanctionNote.append(
        'Nothing selected — an open jackpot. No compliance calendar, no filing deadline, no deduction.',
      );
      return;
    }
    const picked = associations.filter((a) => state.sanctioning.has(a.code));
    for (const a of picked) {
      const bits = [];
      if (a.fee_schedule?.association_pct) {
        bits.push(`${(a.fee_schedule.association_pct * 100).toFixed(0)}% off the top`);
      }
      if (a.results_due_local_time) {
        bits.push(`results due ${a.results_due_local_time} ${a.results_due_timezone}`);
      }
      if (a.mandates_own_system) bits.push('mandates its own system');
      sanctionNote.append(
        h('div', {}, h('strong', {}, a.code), bits.length ? ` — ${bits.join(', ')}` : ''),
        // Honesty about our own data. A profile whose deadline came from a
        // secondary source has to say so on the screen where somebody is about
        // to rely on it, not only in a migration comment.
        a.is_verified
          ? null
          : h('div', { class: 'small', style: 'color:var(--warn)' },
              '⚠ These values are not confirmed against the rule book. Check before you rely on them.'),
      );
    }
  }

  applyPreset('jackpot');
  describeSanctioning();

  async function submit(e) {
    e.preventDefault();
    if (!nameInput.value.trim()) return toast('Give it a name.', true);
    if (state.events.size === 0) return toast('Pick at least one event.', true);

    const events = [...state.events.entries()].map(([code, cfg]) => {
      const meta = eventOptions.find((o) => o.code === code)?.metadata ?? {};
      return {
        event_type: code,
        // The scoring mode comes from the option's own metadata. It is the one
        // thing the engine branches on, so it is never a free choice here.
        scoring_mode: meta.scoring_mode === 'judged' ? 'judged' : 'timed',
        is_roughstock: Boolean(meta.is_roughstock),
        entry_fee: cfg.entry_fee,
        added_money: cfg.added_money,
        num_go_rounds: Number(roundsInput.value || 1),
      };
    });

    try {
      const created = await api.createRodeo({
        name: nameInput.value.trim(),
        rodeo_type: typeSelect.value,
        start_date: startInput.value,
        end_date: endInput.value || startInput.value,
        venue_city: cityInput.value || undefined,
        venue_state: stateInput.value || undefined,
        num_performances: Number(perfInput.value || 1),
        num_go_rounds: Number(roundsInput.value || 1),
        sanctioning: [...state.sanctioning],
        events,
      });
      toast(
        created.compliance_items > 0
          ? `Created. ${created.compliance_items} compliance items to work through.`
          : 'Created. Nothing else to do — go take entries.',
      );
      location.hash = `#/rodeo/${created.id}`;
    } catch (err) {
      toast(err.message, true);
    }
  }

  render(
    h('form', { onsubmit: submit },
      h('h1', {}, 'New rodeo'),
      h('p', { class: 'muted' }, 'Five questions. Everything else follows from them.'),

      h('div', { class: 'card' },
        h('h2', {}, '1 · What are you running?'),
        field('Kind', typeSelect, 'Picks a starting slate of events. Change any of it below.'),
        h('div', { class: 'grid2' },
          field('Name', nameInput),
          field('Go-rounds', roundsInput, 'One for most jackpots.'),
          field('First day', startInput),
          field('Last day', endInput),
          field('City', cityInput),
          field('State', stateInput),
        ),
        field('Performances', perfInput, 'Slack is added later if you need it.'),
      ),

      h('div', { class: 'card' },
        h('h2', {}, '2 · Which events?'),
        h('p', { class: 'small muted' },
          'This list is yours. Add your own in Options and it shows up here.'),
        eventBox,
      ),

      h('div', { class: 'card' },
        h('h2', {}, '3 · Sanctioned by anybody?'),
        sanctionBox,
        sanctionNote,
      ),

      h('div', { class: 'card' },
        h('h2', {}, '4 · Entry fees and added money'),
        feeBox,
      ),

      h('div', { class: 'actions' },
        h('button', { type: 'submit' }, 'Create rodeo'),
        h('a', { class: 'row-link', href: '#/', style: 'padding:10px 18px' }, 'Cancel'),
      ),
    ),
  );

  drawEvents();
  redrawFees();
}
