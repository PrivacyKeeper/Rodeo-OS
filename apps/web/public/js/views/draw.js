/**
 * The draw.
 *
 * ---------------------------------------------------------------------------
 * THE MOST SUSPECTED OPERATION IN RODEO
 * ---------------------------------------------------------------------------
 * Everybody who draws badly believes somebody did it to them, and until now no
 * producer could prove otherwise — they could only say "the computer did it".
 *
 * So this screen leads with the SEED. The draw is generated from a published
 * number, and anybody holding that number and the entry list can re-run the
 * draw themselves and get the identical order. That turns an argument into a
 * check somebody can do on their phone in the parking lot.
 *
 * The seed is shown before the draw is run, not buried in a log afterwards.
 */

import { api } from '../api.js';
import { crumbs, h, render, showPrint, toast } from '../ui.js';

export async function drawView(rodeoId) {
  showPrint(() => window.print());
  const [rodeo, entries] = await Promise.all([
    api.rodeo(rodeoId),
    api.entries(rodeoId),
  ]);

  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Draw' },
  );

  const byEvent = new Map();
  for (const e of entries) {
    const bucket = byEvent.get(e.rodeo_event_id) ?? [];
    bucket.push(e);
    byEvent.set(e.rodeo_event_id, bucket);
  }

  function defaultSeed() {
    // Something a human can read out over a microphone and somebody else can
    // type in. A UUID would be technically fine and socially useless.
    return `${rodeo.slug}-${rodeo.start_date}`;
  }

  const sections = rodeo.events.map((ev) => {
    const rows = byEvent.get(ev.id) ?? [];
    const live = rows.filter((r) => !['scratched', 'turned_out', 'no_show'].includes(r.status));
    const drawn = live.filter((r) => r.draw_position !== null);

    const seedInput = h('input', {
      value: defaultSeed(),
      'aria-label': `Seed for ${ev.label ?? ev.event_type}`,
    });
    const methodSelect = h('select', {},
      h('option', { value: 'random' }, 'Random'),
      h('option', { value: 'sequential' }, 'Entry order'),
    );
    const body = h('tbody', {});

    function drawRows(list) {
      body.replaceChildren(
        ...list.map((r) =>
          h('tr', { class: r.draw_position === null ? 'scratched' : '' },
            h('td', { class: 'pos' }, r.draw_position ?? '—'),
            h('td', {}, r.back_number ?? ''),
            h('td', {}, r.contestant_name),
            h('td', {}, r.horse_name ?? ''),
            h('td', {}, r.performance_number ? `Perf ${r.performance_number}` : 'Slack'),
          ),
        ),
      );
    }
    drawRows(rows);

    async function run() {
      const seed = seedInput.value.trim();
      if (!seed) return toast('The draw needs a seed.', true);
      if (drawn.length > 0 &&
          !confirm(`${ev.label ?? ev.event_type} is already drawn. Re-draw it? Positions will change.`)) {
        return;
      }
      try {
        await api.generateDraw(rodeoId, ev.id, { seed, method: methodSelect.value });
        toast(`${ev.label ?? ev.event_type} drawn. Seed: ${seed}`);
        drawView(rodeoId);
      } catch (err) {
        toast(err.message, true);
      }
    }

    async function drawStock() {
      const seed = seedInput.value.trim();
      try {
        await api.generateStockDraw(rodeoId, ev.id, { seed });
        toast('Stock drawn.');
        drawView(rodeoId);
      } catch (err) {
        toast(err.message, true);
      }
    }

    return h('section', { class: 'card' },
      h('h2', {},
        ev.label ?? ev.event_type,
        h('span', { class: 'muted small' },
          `   ${live.length} up${drawn.length ? ` · ${drawn.length} drawn` : ''}`)),

      live.length === 0
        ? h('p', { class: 'muted' }, 'Nobody entered yet.')
        : h('div', {},
            h('div', { class: 'grid2 noprint' },
              h('label', {}, 'Seed',
                h('span', { class: 'hint' },
                  'Publish this. Anybody with it and the entry list can re-run '
                  + 'the draw and get the same order.'),
                seedInput),
              h('label', {}, 'Method', methodSelect),
            ),
            h('div', { class: 'actions noprint' },
              h('button', { onclick: run }, drawn.length ? 'Re-draw' : 'Run the draw'),
              ev.is_roughstock
                ? h('button', { class: 'ghost', onclick: drawStock }, 'Draw stock')
                : null,
            ),
            h('table', { class: 'sheet', style: 'margin-top:14px' },
              h('thead', {},
                h('tr', {},
                  h('th', {}, '#'), h('th', {}, 'Back'), h('th', {}, 'Contestant'),
                  h('th', {}, 'Horse'), h('th', {}, 'Where'),
                ),
              ),
              body,
            ),
          ),
    );
  });

  render(
    h('div', {},
      h('h1', {}, 'Draw'),
      h('p', { class: 'muted' }, rodeo.name),

      h('div', { class: 'card small noprint' },
        h('strong', {}, 'Every draw here is reproducible. '),
        'It is generated from the seed, not from a random number nobody can '
        + 'check. Read the seed out when you post the draw, and anyone who '
        + 'thinks it was fixed can prove it was not.'),

      sections.length ? sections : h('p', { class: 'muted' }, 'No events.'),

      h('div', { class: 'actions noprint' },
        h('a', { class: 'row-link', style: 'padding:10px 16px', href: `#/rodeo/${rodeoId}/daysheet` },
          'Day sheet →'),
      ),
    ),
  );
}
