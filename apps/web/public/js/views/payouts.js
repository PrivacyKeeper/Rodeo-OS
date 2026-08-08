/**
 * Payouts — review, then disburse.
 *
 * ---------------------------------------------------------------------------
 * TWO STEPS, ALWAYS, AND NEVER ONE
 * ---------------------------------------------------------------------------
 * Calculating a payout and paying it out are separate actions with a human
 * looking at the numbers in between. A secretary reads the placings against
 * the judge's sheet before anybody's money moves, because a wrong time gets
 * caught here or it does not get caught at all.
 *
 * The API refuses to return a calculation that does not reconcile, so anything
 * shown on this screen adds up to the cent by the time it arrives. What the
 * screen adds is the human check on whether the right people are in it.
 */

import { api } from '../api.js';
import { crumbs, h, money, render, showPrint, toast } from '../ui.js';

export async function payoutsView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);

  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Payouts' },
  );

  const [sidepots] = await Promise.all([api.sidepots(rodeoId).catch(() => [])]);

  const container = h('div');

  function lineRows(payouts) {
    return payouts.map((p) =>
      h('tr', {},
        h('td', { class: 'pos' }, p.place ?? ''),
        h('td', {}, p.contestant_name ?? h('span', { class: 'muted' }, p.description ?? p.type)),
        h('td', {}, p.type.replace(/_/g, ' ')),
        h('td', { style: 'text-align:right' }, money(p.amount_cents)),
      ),
    );
  }

  function summary(result) {
    return h('table', { class: 'ledger' },
      h('tbody', {},
        h('tr', {}, h('td', {}, 'Gross purse'), h('td', {}, money(result.gross_purse_cents))),
        h('tr', { class: 'sub' }, h('td', {}, 'Fees'), h('td', {}, `−${money(result.fees.total_cents)}`)),
        h('tr', { class: 'total' }, h('td', {}, 'Net purse'), h('td', {}, money(result.net_purse_cents))),
      ),
    );
  }

  async function calcEvent(ev, target) {
    target.replaceChildren(h('div', { class: 'muted' }, 'Calculating…'));
    try {
      const result = await api.calculatePayouts(rodeoId, ev.id);
      target.replaceChildren(
        summary(result),
        h('table', { class: 'sheet', style: 'margin-top:12px' },
          h('thead', {}, h('tr', {},
            h('th', {}, '#'), h('th', {}, 'Who'), h('th', {}, 'Line'),
            h('th', { style: 'text-align:right' }, 'Amount'))),
          h('tbody', {}, lineRows(result.payouts)),
        ),
        result.unpaid_cents
          ? h('p', { class: 'muted small' },
              `${money(result.unpaid_cents)} unpaid — not enough qualified runs to fill the ladder.`)
          : null,
        result.escrow_cents
          ? h('p', { class: 'muted small' }, `${money(result.escrow_cents)} held in escrow.`)
          : null,
        result.issues?.length
          ? h('div', {}, result.issues.map((i) =>
              h('div', { class: `issue ${i.severity === 'error' ? 'blocker' : 'warning'}` },
                h('div', { class: 'where' }, i.code),
                h('div', {}, i.message))))
          : null,
        h('div', { class: 'actions noprint' },
          h('button', {
            onclick: async () => {
              if (!confirm(`Disburse ${money(result.net_purse_cents)} for ${ev.label ?? ev.event_type}? This writes to the ledger.`)) return;
              try {
                await api.disburse(rodeoId, ev.id);
                toast('Disbursed. The ledger has it.');
              } catch (err) { toast(err.message, true); }
            },
          }, `Disburse ${money(result.net_purse_cents)}`),
        ),
      );
    } catch (err) {
      target.replaceChildren(
        h('div', { class: 'issue blocker' },
          h('div', { class: 'where' }, err.code ?? 'Error'),
          h('div', {}, err.message),
          err.details?.issues
            ? h('div', { class: 'fix' },
                err.details.issues.map((i) => i.message).join(' · '))
            : null),
      );
    }
  }

  const eventCards = rodeo.events.map((ev) => {
    const target = h('div', {},
      h('p', { class: 'muted' }, 'Not calculated yet.'));
    return h('section', { class: 'card' },
      h('h2', {}, ev.label ?? ev.event_type,
        h('span', { class: 'muted small' }, `   ${ev.entries} entered · ${ev.scored} scored`)),
      h('div', { class: 'actions noprint' },
        h('button', { class: 'ghost', onclick: () => calcEvent(ev, target) }, 'Calculate'),
      ),
      target,
    );
  });

  const sidepotCards = sidepots.map((sp) => {
    const target = h('div', {}, h('p', { class: 'muted' }, 'Not calculated yet.'));
    return h('section', { class: 'card' },
      h('h3', {}, sp.name,
        h('span', { class: 'muted small' },
          `   ${sp.event_label} · ${sp.buyers} in · ${money(Number(sp.collected_cents))} collected`)),
      h('div', { class: 'actions noprint' },
        h('button', {
          class: 'ghost',
          onclick: async () => {
            target.replaceChildren(h('div', { class: 'muted' }, 'Calculating…'));
            try {
              const r = await api.calculateSidepot(rodeoId, sp.id);
              target.replaceChildren(
                h('p', { class: 'muted small' },
                  `${r.buyers} paid buy-ins`
                  + (r.unpaid_buyers ? ` · ${r.unpaid_buyers} said in but never paid, and are not in the pot` : '')),
                h('table', { class: 'sheet' },
                  h('thead', {}, h('tr', {},
                    h('th', {}, '#'), h('th', {}, 'Who'), h('th', {}, 'Line'),
                    h('th', { style: 'text-align:right' }, 'Amount'))),
                  h('tbody', {}, lineRows(r.payouts)),
                ),
              );
            } catch (err) {
              target.replaceChildren(
                h('div', { class: 'issue blocker' },
                  h('div', { class: 'where' }, err.code ?? 'Error'),
                  h('div', {}, err.message)),
              );
            }
          },
        }, 'Calculate'),
      ),
      target,
    );
  });

  container.replaceChildren(
    h('h1', {}, 'Payouts'),
    h('p', { class: 'muted' }, rodeo.name),
    h('div', { class: 'card small noprint' },
      'Calculate, read it against the judge\'s sheet, then disburse. '
      + 'Nothing that fails to reconcile to the cent will appear on this page — '
      + 'the API refuses to serve it.'),
    ...eventCards,
    sidepotCards.length
      ? h('div', {}, h('h2', {}, 'Sidepots'), ...sidepotCards)
      : null,
    h('div', { class: 'actions noprint' },
      h('a', { class: 'row-link', style: 'padding:10px 16px', href: `#/rodeo/${rodeoId}/books` },
        'Close the books →'),
    ),
  );

  render(container);
}
