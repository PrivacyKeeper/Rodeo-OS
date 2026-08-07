/**
 * Closing the books.
 *
 * ---------------------------------------------------------------------------
 * IT IS TEN AT NIGHT.
 * ---------------------------------------------------------------------------
 * The last steer has run. She is alone in an arena office, tired, and the
 * association's deadline is 11:59 with a fine on the other side of it.
 *
 * So this screen shows, in this order:
 *
 *   1. How long she has left. Big enough to read from across the room.
 *   2. Exactly what is still wrong, each one naming a person or an event and
 *      what to do about it. Not "3 issues found".
 *   3. The money, so she can see it balances before she commits.
 *   4. One button.
 *
 * Warnings are below the fold and never stop anything. A secretary who cannot
 * file at 11:40 because the software wants a sponsorship agreement uploaded
 * will not open the software again, and she would be right.
 */

import { api } from '../api.js';
import { crumbs, duration, h, money, render, showPrint, toast } from '../ui.js';

function countdown(deadline) {
  if (!deadline?.due_at) {
    return h('div', { class: 'muted' }, 'No filing deadline — nobody sanctions this one.');
  }
  const remaining = deadline.ms_remaining ?? 0;
  return h('div', {},
    h('div', { class: `countdown${deadline.passed ? ' late' : ''}` },
      deadline.passed
        ? `${duration(remaining)} late`
        : `${duration(remaining)} to file`),
    h('div', { class: 'small muted' },
      `Due ${new Date(deadline.due_at).toLocaleString()}`,
      deadline.late_fee_cents ? ` · late fee ${money(deadline.late_fee_cents)}` : ''),
    deadline.passed
      ? h('div', { class: 'small', style: 'color:var(--warn);margin-top:6px' },
          'File it anyway. Late is recoverable; unfiled is not.')
      : null,
  );
}

function issue(item, kind) {
  return h('div', { class: `issue ${kind}` },
    h('div', { class: 'where' }, item.where),
    h('div', {}, item.message),
    h('div', { class: 'fix' }, '→ ', item.fix),
  );
}

function ledger(t) {
  const line = (label, value, cls = '') =>
    h('tr', { class: cls }, h('td', {}, label), h('td', {}, value));
  return h('table', { class: 'ledger' },
    h('tbody', {},
      line('Entries', `${t.entries}  (${t.live_entries} competing, ${t.scratched_entries} out)`, 'sub'),
      line('Entry fees collected', money(t.fees_collected_cents)),
      line('Added money', money(t.added_money_cents)),
      line('Gross purse', money(t.gross_purse_cents)),
      t.association_deduction_cents
        ? line('Association deduction', `−${money(t.association_deduction_cents)}`, 'sub')
        : null,
      line('Net purse', money(t.net_purse_cents)),
      line('Paid — placings', money(t.paid_out_cents), 'sub'),
      t.ground_money_cents ? line('Paid — ground money', money(t.ground_money_cents), 'sub') : null,
      t.day_money_cents ? line('Paid — day money', money(t.day_money_cents), 'sub') : null,
      h('tr', { class: 'total' },
        h('td', {}, 'Still to disburse'),
        h('td', {}, money(t.unpaid_purse_cents)),
      ),
    ),
  );
}

export async function booksView(rodeoId) {
  showPrint(() => window.print());
  const books = await api.books(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: books.rodeo_name, href: `#/rodeo/${rodeoId}` },
    { label: 'Books' },
  );

  const closed = books.state === 'closed' || books.state === 'filed';

  async function doClose() {
    try {
      const out = await api.closeBooks(rodeoId);
      toast(`Closed. Net purse ${money(out.totals.net_purse_cents)}.`);
      booksView(rodeoId);
    } catch (err) {
      if (err.code === 'BOOKS_NOT_READY') {
        toast(`${err.details?.blockers?.length ?? 0} still to fix.`, true);
        booksView(rodeoId);
        return;
      }
      toast(err.message, true);
    }
  }

  async function doFile() {
    const reference = prompt('Association reference, if you have one:') ?? '';
    try {
      await api.fileBooks(rodeoId, reference || null, Boolean(books.deadline?.passed));
      toast('Filed.');
      booksView(rodeoId);
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function doReopen() {
    const reason = prompt('Why are you reopening? This goes on the record.') ?? '';
    if (reason.trim().length < 4) return toast('A reason is required.', true);
    try {
      await api.reopenBooks(rodeoId, reason.trim());
      toast('Reopened.');
      booksView(rodeoId);
    } catch (err) {
      toast(err.message, true);
    }
  }

  render(
    h('div', {},
      h('h1', {}, 'Close the books'),
      h('p', { class: 'muted' },
        books.rodeo_name,
        books.association ? `  ·  ${books.association}` : '  ·  Open',
        `  ·  ${books.state}`),

      h('div', { class: 'card' }, countdown(books.deadline)),

      books.blockers.length
        ? h('div', {},
            h('h2', {}, `${books.blockers.length} thing${books.blockers.length === 1 ? '' : 's'} to fix`),
            books.blockers.map((b) => issue(b, 'blocker')))
        : h('div', { class: 'card' },
            h('h2', { style: 'margin:0;color:var(--ok)' }, '✓ Nothing is wrong'),
            h('p', { class: 'muted' },
              'Every run is scored, every placing is official, and the money reconciles to the cent.')),

      h('h2', {}, 'The money'),
      h('div', { class: 'card' }, ledger(books.totals)),

      h('div', { class: 'actions noprint' },
        !closed
          ? h('button', { disabled: !books.ready ? true : null, onclick: doClose },
              books.ready ? 'Close the books' : `Fix ${books.blockers.length} first`)
          : null,
        books.state === 'closed'
          ? h('button', { onclick: doFile }, 'Mark as filed')
          : null,
        closed || books.state === 'reopened'
          ? h('button', { class: 'ghost', onclick: doReopen }, 'Reopen')
          : null,
      ),

      books.warnings.length
        ? h('div', { class: 'noprint' },
            h('h2', {}, 'Worth knowing — none of this stops you filing'),
            books.warnings.map((w) => issue(w, 'warning')))
        : null,
    ),
  );
}
