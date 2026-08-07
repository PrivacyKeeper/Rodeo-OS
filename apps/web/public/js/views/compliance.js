/**
 * Sanctioning — the compliance calendar.
 *
 * ---------------------------------------------------------------------------
 * A JACKPOT NEVER REACHES THIS SCREEN.
 * ---------------------------------------------------------------------------
 * It is not linked from an unsanctioned rodeo, and if somebody types the URL
 * they get an empty list and a sentence saying why. The list is generated from
 * the associations that approved the rodeo; approve nobody and there is
 * nothing here, forever.
 *
 * None of these items blocks closing the books. The countdown a secretary is
 * fighting at eleven at night is not the sponsorship agreement.
 */

import { api } from '../api.js';
import { crumbs, h, money, render, showPrint, toast } from '../ui.js';

const TYPE_LABEL = {
  document: 'Document',
  insurance: 'Insurance',
  escrow: 'Escrow',
  fee: 'Fee',
  personnel: 'Personnel',
  welfare: 'Welfare',
  filing: 'Filing',
};

function statusPill(status, dueOn) {
  if (status === 'satisfied') return h('span', { class: 'pill ok' }, 'Done');
  if (status === 'waived') return h('span', { class: 'pill' }, 'Waived');
  if (status === 'failed') return h('span', { class: 'pill stop' }, 'Failed');
  const overdue = dueOn && dueOn < new Date().toISOString().slice(0, 10);
  return h('span', { class: overdue ? 'pill stop' : 'pill warn' }, overdue ? 'Overdue' : 'To do');
}

export async function complianceView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Sanctioning' },
  );

  let items = await api.compliance(rodeoId);

  async function refresh() {
    items = await api.compliance(rodeoId);
    draw();
  }

  async function setStatus(item, status) {
    const patch = { status };
    if (status === 'waived') {
      const reason = prompt('Why is this being waived? It goes on the record.') ?? '';
      if (reason.trim().length < 4) return toast('A reason is required.', true);
      patch.waived_reason = reason.trim();
    }
    try {
      await api.patchCompliance(rodeoId, item.id, patch);
      toast(status === 'satisfied' ? 'Marked done.' : 'Updated.');
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function draw() {
    if (rodeo.sanctioned_by.length === 0) {
      render(
        h('div', {},
          h('h1', {}, 'Sanctioning'),
          h('div', { class: 'card' },
            h('h2', {}, 'Nobody sanctions this rodeo'),
            h('p', { class: 'muted' },
              'So there is nothing to file, nothing to escrow, and no deadline. ' +
              'Add a sanctioning body in setup if that changes.')),
        ),
      );
      return;
    }

    const outstanding = items.filter((i) => i.status !== 'satisfied' && i.status !== 'waived');

    render(
      h('div', {},
        h('h1', {}, 'Sanctioning'),
        h('p', { class: 'muted' },
          `${rodeo.sanctioned_by.join(' · ')}  ·  ${outstanding.length} of ${items.length} outstanding`),

        h('div', { class: 'card small muted' },
          'These are reminders, not gates. Nothing on this page stops you closing ' +
          'the books or filing your results.'),

        items.length === 0
          ? h('div', { class: 'card' },
              h('p', { class: 'muted' }, 'No checklist yet.'),
              h('div', { class: 'actions' },
                h('button', {
                  onclick: async () => {
                    const created = await api.generateCompliance(rodeoId);
                    toast(`${created.length} items.`);
                    refresh();
                  },
                }, 'Build the checklist')))
          : h('div', { class: 'rows', style: 'margin-top:16px' },
              items.map((item) =>
                h('div', { class: 'row-link', style: 'cursor:default' },
                  h('div', {},
                    h('strong', {}, item.label),
                    h('span', { class: 'muted small' },
                      [item.association_code,
                       TYPE_LABEL[item.requirement_type] ?? item.requirement_type,
                       item.due_on ? `due ${item.due_on}` : null,
                       item.amount_cents ? money(item.amount_cents) : null,
                      ].filter(Boolean).join('  ·  ')),
                  ),
                  h('div', { style: 'display:flex;gap:8px;align-items:center' },
                    statusPill(item.status, item.due_on),
                    item.status === 'satisfied' || item.status === 'waived'
                      ? null
                      : h('button', { class: 'ghost noprint', onclick: () => setStatus(item, 'satisfied') }, 'Done'),
                    item.status === 'satisfied' || item.status === 'waived'
                      ? null
                      : h('button', { class: 'ghost noprint', onclick: () => setStatus(item, 'waived') }, 'Waive'),
                  ),
                ),
              ),
            ),
      ),
    );
  }

  draw();
}
