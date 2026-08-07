/**
 * Scoring.
 *
 * ---------------------------------------------------------------------------
 * ONE RUN AT A TIME, IN DRAW ORDER, WITHOUT LOOKING AWAY FROM THE ARENA.
 * ---------------------------------------------------------------------------
 * The person typing here is watching the run happen. So the list is the day
 * sheet's order, the input is already focused, Enter moves to the next
 * contestant, and nothing is more than one field wide.
 *
 * Scores land as PROVISIONAL. The arena reverses a call between the run and
 * the results going up more often than any software design admits, and a
 * number that is instantly official is a number somebody has to fight to
 * change. Finalising an event is a separate, deliberate action.
 */

import { api } from '../api.js';
import { crumbs, h, render, showPrint, toast } from '../ui.js';

export async function scoringView(rodeoId) {
  showPrint(null);
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Scoring' },
  );

  const sheet = await api.daySheet(rodeoId, null);

  const sections = sheet.sections.map((section) => {
    const event = rodeo.events.find((e) => e.id === section.rodeo_event_id);
    const inputs = [];

    const rows = section.runs
      .filter((r) => !r.is_scratched)
      .map((run, i) => {
        const input = h('input', {
          class: 'scoreinput',
          type: 'number',
          step: section.scoring_mode === 'timed' ? '0.01' : '0.5',
          min: '0',
          inputmode: 'decimal',
          placeholder: section.scoring_mode === 'timed' ? 'seconds' : 'score',
          'aria-label': `${run.contestant_name} ${section.scoring_mode === 'timed' ? 'time' : 'score'}`,
          onkeydown: (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            save(run, input, section, event);
            inputs[i + 1]?.focus();
          },
        });
        inputs.push(input);

        return h('tr', {},
          h('td', { class: 'pos' }, run.position),
          h('td', {}, run.contestant_name,
            run.partner_name ? h('span', { class: 'muted small' }, ` / ${run.partner_name}`) : null),
          h('td', { class: 'muted small' },
            section.is_roughstock ? run.stock_name ?? '' : run.horse_name ?? ''),
          h('td', {}, input),
          h('td', {},
            h('button', { class: 'ghost', onclick: () => save(run, input, section, event) }, 'Save'),
          ),
          h('td', {},
            h('button', {
              class: 'ghost',
              onclick: () => save(run, input, section, event, ['no_catch']),
            }, 'No time'),
          ),
        );
      });

    async function save(run, input, sec, ev, dqTriggers) {
      if (!ev?.id) return toast('This event has no configuration.', true);
      const value = Number(input.value);
      if (!dqTriggers && !Number.isFinite(value)) return toast('Enter a number.', true);
      try {
        await api.submitScore(`${rodeoId}/events/${sec.rodeo_event_id}`, {
          entry_id: run.entry_id,
          contestant_id: run.contestant_id,
          go_round: run.go_round,
          ...(sec.scoring_mode === 'timed'
            ? { raw_time: dqTriggers ? null : value }
            : { judges: [] }),
          ...(dqTriggers ? { dq_triggers: dqTriggers } : {}),
        });
        input.style.borderColor = 'var(--ok)';
        toast(`${run.contestant_name} saved`);
      } catch (err) {
        input.style.borderColor = 'var(--stop)';
        toast(err.message, true);
      }
    }

    return h('section', { class: 'card' },
      h('h2', {},
        section.event_label,
        section.go_round > 1 ? ` — Round ${section.go_round}` : '',
        h('span', { class: 'muted small' }, `   ${section.live_count} up`),
      ),
      h('table', { class: 'sheet' },
        h('tbody', {}, rows),
      ),
      h('div', { class: 'actions' },
        h('button', {
          class: 'ghost',
          onclick: async () => {
            try {
              await api.finalize(rodeoId, section.rodeo_event_id, false);
              toast('Placings computed. Look them over, then make them official.');
            } catch (err) { toast(err.message, true); }
          },
        }, 'Compute placings'),
        h('button', {
          onclick: async () => {
            try {
              await api.finalize(rodeoId, section.rodeo_event_id, true);
              toast('Official. This is what contestants and the public now see.');
            } catch (err) { toast(err.message, true); }
          },
        }, 'Make official'),
      ),
    );
  });

  render(
    h('div', {},
      h('h1', {}, 'Scoring'),
      h('p', { class: 'muted' },
        'Type the time, press Enter, it saves and moves down. Everything lands provisional.'),
      sections.length
        ? sections
        : h('div', { class: 'card' },
            h('p', { class: 'muted' }, 'Nothing drawn yet.')),
    ),
  );
}
