/**
 * Releases — who has signed, and taking a signature.
 *
 * ---------------------------------------------------------------------------
 * THE SCREEN SHOWS THE DOCUMENT BEFORE IT TAKES THE SIGNATURE
 * ---------------------------------------------------------------------------
 * Not a checkbox next to a link to the document — the text itself, on the
 * screen, above the button. The entire legal weight of a release rests on the
 * signer having seen it, and a system that stores a hash of text the signer
 * was never shown has built an audit trail for a fiction.
 *
 * Two ways to sign, because rodeos collect both:
 *
 *   * The contestant signs on this device, typing their name. The record says
 *     they did it themselves.
 *   * The secretary records a paper release handed over at the gate. The
 *     record says the secretary put it there, and says so permanently — that
 *     is `recorded_by`, and it is the difference between evidence and a
 *     convenient row.
 *
 * Neither path sends a hash. Both hashes are computed by the database from the
 * stored template, because a hash the browser produced proves only that the
 * browser can hash.
 */

import { api } from '../api.js';
import { crumbs, h, render, showPrint, toast } from '../ui.js';

export async function waiversView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Releases' },
  );

  let templates = [];
  let rows = [];
  let meta = {};
  let openTemplate = null;

  async function load() {
    templates = await api.waiverTemplates();
    const res = await api.waiverShortfall(rodeoId);
    rows = res.data ?? res;
    meta = res.meta ?? {};
    draw();
  }

  async function sign(row, method) {
    const template = templates.find((t) => t.id === row.template_id);
    if (!template) return toast('That release is no longer active.', true);

    const who = `${row.first_name} ${row.last_name}`.trim();
    const typed = prompt(
      method === 'paper_on_file'
        ? `Recording a PAPER release for ${who}.\n\n`
          + 'Type the name exactly as it is signed on the paper:'
        : `${who} is signing here, now.\n\nType your full name:`,
      who,
    );
    if (!typed || !typed.trim()) return;

    try {
      await api.signWaiver({
        template_id: row.template_id,
        user_id: row.contestant_id,
        method,
        typed_name: typed.trim(),
        rodeo_id: rodeoId,
      });
      toast('On file.');
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function documentPanel() {
    if (!openTemplate) return null;
    const t = templates.find((x) => x.id === openTemplate);
    if (!t) return null;
    return h('section', { class: 'card' },
      h('div', { class: 'actions', style: 'justify-content:space-between' },
        h('h2', {}, t.name),
        h('button', {
          class: 'small ghost',
          onclick: () => { openTemplate = null; draw(); },
        }, 'Close'),
      ),
      h('p', { class: 'muted small' }, `Version ${t.version}`),
      // The text, in full. Not a link to it.
      h('pre', {
        style: 'white-space:pre-wrap;font:inherit;margin:0;padding:12px;'
          + 'border:1px solid var(--line);border-radius:8px;max-height:40vh;overflow:auto',
      }, t.body_text),
    );
  }

  function shortfallPanel() {
    if (rows.length === 0) {
      return h('section', { class: 'card' },
        h('h2', {}, 'Releases'),
        h('p', { class: 'muted small' },
          templates.length === 0
            ? 'No release has been set up for this organisation yet.'
            : 'Nobody is entered yet, so there is nobody to collect from.'),
      );
    }

    const missing = rows.filter((r) => !r.signed);
    return h('section', { class: 'card' },
      h('h2', {}, 'Who has signed'),
      h('p', { class: meta.missing > 0 ? 'muted small warnline' : 'muted small' },
        meta.missing > 0
          ? `${meta.people_missing} contestant(s) still owe ${meta.missing} release(s).`
          : 'Everybody entered has signed everything required.'),
      h('table', { class: 'sheet' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Contestant'),
          h('th', {}, 'Release'),
          h('th', {}, 'Status'),
          h('th', {}, ''),
        )),
        h('tbody', {}, (missing.length > 0 ? missing.concat(rows.filter((r) => r.signed)) : rows)
          .map((r) => h('tr', {},
            h('td', {}, `${r.first_name} ${r.last_name}`),
            h('td', {},
              h('button', {
                class: 'ghost small',
                onclick: () => { openTemplate = r.template_id; draw(); },
              }, r.template_name)),
            h('td', {}, r.signed
              ? h('span', { class: 'pill ok' }, 'On file')
              : h('span', { class: 'pill stop' }, 'Missing')),
            h('td', {}, r.signed ? null : h('div', { class: 'actions', style: 'gap:6px' },
              h('button', {
                class: 'small',
                onclick: () => { openTemplate = r.template_id; draw(); },
              }, 'Read it'),
              h('button', {
                class: 'small',
                onclick: () => sign(r, 'typed_name'),
              }, 'Sign here'),
              h('button', {
                class: 'small ghost',
                onclick: () => sign(r, 'paper_on_file'),
              }, 'Paper on file'),
            )),
          ))),
      ),
    );
  }

  function draw() {
    render(h('div', {},
      h('h1', {}, 'Releases'),
      h('p', { class: 'muted' },
        'Show the document, then take the signature. The text is hashed by the '
        + 'server at the moment of signing, so a release edited later can be '
        + 'proved to have changed.'),
      documentPanel(),
      shortfallPanel(),
    ));
  }

  await load();
}
