/**
 * Year-end — what the accountant needs in January.
 *
 * ---------------------------------------------------------------------------
 * THIS SCREEN FILES NOTHING, AND SAYS SO
 * ---------------------------------------------------------------------------
 * The database holds the last four digits of a tax identifier and nothing
 * more, deliberately. There is no SSN here, so there is no 1099 this system
 * could transmit even if somebody asked it to. What it can do is the part that
 * is currently done out of a shoebox: add up who was paid, apply the threshold
 * that was actually in force for that year, and produce the list of people who
 * crossed it without ever handing in a W-9.
 *
 * The threshold is shown on screen rather than assumed. It moved for 2026 —
 * from $600 to $2,000 — and is indexed from here on, so a bare list of totals
 * would give a producer no way to tell which rule produced it.
 */

import { api } from '../api.js';
import { crumbs, h, money, render, showPrint, toast } from '../ui.js';

export async function yearEndView() {
  showPrint(() => window.print());
  crumbs({ label: 'Rodeos', href: '#/' }, { label: 'Year-end' });

  // Default to last year: this screen is opened in January.
  let year = new Date().getUTCFullYear() - 1;
  let rows = [];
  let meta = {};
  let error = null;

  async function load() {
    error = null;
    try {
      const res = await api.taxSummary(year);
      rows = res.data ?? res;
      meta = res.meta ?? {};
    } catch (err) {
      error = err.message;
      rows = [];
      meta = {};
    }
    draw();
  }

  function csv() {
    // Tab-separated and copied to the clipboard rather than a download: the
    // accountant wants it in a spreadsheet, and this app has no build step and
    // no file server.
    const header = [
      'Last', 'First', 'Address', 'City', 'State', 'Postal', 'Country',
      'Tax ID', 'Verified', 'Gross', 'Withheld', 'Net', 'Payments',
      'Form', 'Reportable',
    ].join('\t');
    const body = rows.map((r) => [
      r.last_name, r.first_name, r.address_line1 ?? '', r.city ?? '',
      r.state_province ?? '', r.postal_code ?? '', r.country ?? '',
      r.tax_id_last4 ? `${r.tax_id_type ?? ''} ••••${r.tax_id_last4}` : 'MISSING',
      r.tax_id_verified ? 'yes' : 'no',
      (Number(r.gross_cents) / 100).toFixed(2),
      (Number(r.withholding_cents) / 100).toFixed(2),
      (Number(r.net_cents) / 100).toFixed(2),
      r.payment_count, r.form, r.reportable ? 'yes' : 'no',
    ].join('\t')).join('\n');

    navigator.clipboard.writeText(`${header}\n${body}`).then(
      () => toast('Copied. Paste into a spreadsheet.'),
      () => toast('Could not copy.', true),
    );
  }

  function draw() {
    const reportable = rows.filter((r) => r.reportable);
    const chasing = rows.filter((r) => r.missing_tax_id);

    render(h('div', {},
      h('h1', {}, 'Year-end'),
      h('p', { class: 'muted' },
        'Everybody this organisation paid, against the reporting threshold in '
        + 'force for that year.'),

      h('section', { class: 'card' },
        h('div', { class: 'actions', style: 'gap:10px;align-items:end;flex-wrap:wrap' },
          h('label', {}, 'Tax year',
            h('input', {
              type: 'number', value: year, min: 2000, max: 2100,
              style: 'width:8em',
              onchange: (e) => { year = Number(e.target.value); load(); },
            })),
          rows.length > 0
            ? h('button', { class: 'small', onclick: csv }, 'Copy for spreadsheet')
            : null,
        ),
        meta.threshold_cents !== null && meta.threshold_cents !== undefined
          ? h('p', { class: 'muted small' },
              `${meta.form ?? 'Form'} · threshold ${money(meta.threshold_cents)} `
              + `for ${meta.year}`)
          : null,
      ),

      error
        ? h('section', { class: 'card' },
            h('p', { class: 'muted small warnline' }, error),
            h('p', { class: 'muted small' },
              'This report is limited to owners and administrators.'))
        : null,

      !error && rows.length === 0
        ? h('section', { class: 'card' },
            h('p', { class: 'muted small' }, `Nothing was paid out in ${year}.`))
        : null,

      rows.length > 0
        ? h('section', { class: 'card' },
            h('h2', {}, 'Paid'),
            h('p', { class: chasing.length > 0 ? 'muted small warnline' : 'muted small' },
              `${rows.length} paid · ${reportable.length} reportable`
              + (chasing.length > 0
                ? ` · ${chasing.length} over the threshold with no verified W-9`
                : '')),
            h('table', { class: 'sheet' },
              h('thead', {}, h('tr', {},
                h('th', {}, 'Who'),
                h('th', {}, 'Where'),
                h('th', {}, 'Tax ID'),
                h('th', { class: 'num' }, 'Gross'),
                h('th', { class: 'num' }, 'Withheld'),
                h('th', { class: 'num' }, 'Net'),
                h('th', {}, ''),
              )),
              h('tbody', {}, rows.map((r) => h('tr', {},
                h('td', {}, `${r.first_name} ${r.last_name}`),
                h('td', {}, [r.city, r.state_province].filter(Boolean).join(', ') || '—'),
                h('td', {},
                  r.tax_id_last4
                    ? h('span', { class: r.tax_id_verified ? 'pill ok' : 'pill warn' },
                        `••••${r.tax_id_last4}`)
                    : h('span', { class: r.reportable ? 'pill stop' : 'pill' }, 'None')),
                h('td', { class: 'num' }, money(r.gross_cents)),
                h('td', { class: 'num' },
                  Number(r.withholding_cents) > 0 ? money(r.withholding_cents) : '—'),
                h('td', { class: 'num' }, money(r.net_cents)),
                h('td', {}, r.reportable
                  ? h('span', { class: 'pill warn' }, r.form)
                  : h('span', { class: 'muted small' }, 'Under')),
              ))),
            ))
        : null,

      rows.length > 0
        ? h('section', { class: 'card' },
            h('h3', {}, 'Before you file'),
            h('p', { class: 'muted small' }, meta.advisory
              ?? 'Reporting figures only. This system files nothing.'))
        : null,
    ));
  }

  await load();
}
