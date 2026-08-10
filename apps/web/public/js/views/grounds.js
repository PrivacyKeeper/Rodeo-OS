/**
 * The grounds — stalls, RV spots, camping and arena time.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS
 * ---------------------------------------------------------------------------
 * Entry fees are the contestants' money passing through. Stall fees and RV
 * hookups are the producer's own income, and until this screen the books
 * reconciled the money that passes through and said nothing about the money
 * they keep. That is half a set of books, and it is the half they personally
 * care about.
 *
 * The availability panel is the point. A secretary with a queue in front of
 * her needs to answer "have you got a stall Friday to Sunday" in one look, and
 * the answer has to count bookings that OVERLAP those nights rather than
 * bookings that happen to start on Friday — which is the difference between an
 * honest answer and two horses in one stall.
 */

import { api } from '../api.js';
import { crumbs, h, money, render, showPrint, toast } from '../ui.js';

const TYPE_LABEL = {
  stall: 'Stall',
  rv_spot: 'RV spot',
  tack_room: 'Tack room',
  pen: 'Pen',
  arena_slot: 'Arena time',
  clinic_seat: 'Clinic seat',
  vendor_space: 'Vendor space',
  camping: 'Camping',
};

const UNIT_LABEL = {
  per_night: '/night',
  per_stay: '/stay',
  per_head: '/head',
};

function statusPill(b) {
  if (b.status === 'cancelled') return h('span', { class: 'pill' }, 'Cancelled');
  if (b.status === 'completed') return h('span', { class: 'pill ok' }, 'Done');
  if (b.status === 'no_show') return h('span', { class: 'pill stop' }, 'No show');
  if (b.paid) return h('span', { class: 'pill ok' }, 'Paid');
  return h('span', { class: 'pill warn' }, 'Held, unpaid');
}

export async function groundsView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Grounds' },
  );

  // Default the availability window to the rodeo itself, which is what is
  // being asked about ninety-nine times in a hundred. Departure is the day
  // after the last day: the range is half-open, so a stay that ends on the
  // 12th means the stall is free on the 12th.
  let from = rodeo.start_date;
  let to = nextDay(rodeo.end_date);

  let avail = [];
  let bookings = [];

  function nextDay(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  async function load() {
    // api.request() unwraps the response envelope and returns `data`, so the
    // server's `meta` counts never arrive here. Everything shown below is
    // derived from the rows instead — which is the house pattern, and means
    // one fewer thing that can disagree with what is on screen.
    [avail, bookings] = await Promise.all([
      api.availability(from, to, rodeoId),
      api.bookings(rodeoId),
    ]);
    draw();
  }

  async function take(resource) {
    const who = prompt(`Who is taking ${resource.name}?`);
    if (!who || !who.trim()) return;
    try {
      await api.book({
        resource_id: resource.id,
        from,
        to,
        contact_name: who.trim(),
        rodeo_id: rodeoId,
      });
      toast('Booked.');
      load();
    } catch (err) {
      // 409 is the honest answer "somebody already has it", not a fault.
      toast(err.message, true);
    }
  }

  async function confirm(b) {
    const ref = prompt('Payment reference (cash, cheque number, receipt):') ?? '';
    try {
      await api.confirmBooking(b.id, ref.trim() || null);
      toast('Confirmed.');
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function cancel(b) {
    const reason = prompt('Why is this being cancelled? It goes on the record.') ?? '';
    if (reason.trim().length < 3) return toast('A reason is required.', true);
    try {
      await api.cancelBooking(b.id, reason.trim());
      toast('Cancelled. The dates are free again.');
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function sweep() {
    try {
      const released = await api.expireHolds();
      const n = released.length;
      toast(n === 0 ? 'No holds had expired.' : `Released ${n} expired hold(s).`);
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function addResource() {
    const name = prompt('What is it called? e.g. "Barn 3, Stall 14"');
    if (!name || !name.trim()) return;
    const type = prompt('Type: stall, rv_spot, camping, pen, tack_room, arena_slot,'
      + ' clinic_seat, vendor_space', 'stall');
    if (!type) return;
    const price = prompt('Price in dollars (0 for free):', '35');
    const capacity = prompt('How many can be booked at once? (1 for a single stall)', '1');
    try {
      await api.createResource({
        rodeo_id: rodeoId,
        resource_type: type.trim(),
        name: name.trim(),
        price_cents: Math.round(Number(price || 0) * 100),
        price_unit: Number(capacity) > 1 ? 'per_stay' : 'per_night',
        capacity: Math.max(1, Number(capacity) || 1),
      });
      toast('Added.');
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function availabilityPanel() {
    return h('section', { class: 'card' },
      h('h2', {}, 'What is free'),
      h('div', { class: 'actions', style: 'gap:10px;align-items:end;flex-wrap:wrap' },
        h('label', {}, 'Arrive',
          h('input', {
            type: 'date', value: from,
            onchange: (e) => { from = e.target.value; load(); },
          })),
        h('label', {}, 'Leave',
          h('input', {
            type: 'date', value: to,
            onchange: (e) => { to = e.target.value; load(); },
          })),
        h('span', { class: 'muted small' },
          'Leaving date is the morning they go — the stall is free that day.'),
      ),
      avail.length === 0
        ? h('p', { class: 'muted small' },
            'Nothing is set up yet. Add a stall or an RV spot to start taking bookings.')
        : h('table', { class: 'sheet' },
            h('thead', {}, h('tr', {},
              h('th', {}, 'What'),
              h('th', {}, 'Type'),
              h('th', { class: 'num' }, 'Price'),
              h('th', { class: 'num' }, 'Free'),
              h('th', {}, ''),
            )),
            h('tbody', {}, avail.map((r) => h('tr', {},
              h('td', {}, r.name),
              h('td', {}, TYPE_LABEL[r.resource_type] ?? r.resource_type),
              h('td', { class: 'num' },
                r.price_cents === 0
                  ? '—'
                  : `${money(r.price_cents)}${UNIT_LABEL[r.price_unit] ?? ''}`),
              h('td', { class: 'num' },
                r.remaining === 0
                  ? h('span', { class: 'pill stop' }, 'Taken')
                  : `${r.remaining} of ${r.capacity}`),
              h('td', {},
                r.remaining === 0
                  ? null
                  : h('button', { class: 'small', onclick: () => take(r) }, 'Book')),
            ))),
          ),
      h('div', { class: 'actions', style: 'gap:8px;margin-top:10px' },
        h('button', { class: 'small', onclick: addResource }, '+ Add a stall or spot'),
      ),
    );
  }

  function bookingsPanel() {
    const live = bookings.filter(
      (b) => b.status === 'held' || b.status === 'confirmed',
    );
    const unpaid = live.filter((b) => !b.paid);
    const owed = unpaid.reduce((sum, b) => sum + b.amount_cents, 0);
    return h('section', { class: 'card' },
      h('h2', {}, 'Bookings'),
      h('p', { class: 'muted small' },
        `${live.length} live · ${unpaid.length} unpaid`,
        owed > 0 ? ` · ${money(owed)} outstanding` : ''),
      bookings.length === 0
        ? h('p', { class: 'muted small' }, 'Nobody has booked anything yet.')
        : h('table', { class: 'sheet' },
            h('thead', {}, h('tr', {},
              h('th', {}, 'Who'),
              h('th', {}, 'What'),
              h('th', {}, 'In'),
              h('th', {}, 'Out'),
              h('th', { class: 'num' }, 'Amount'),
              h('th', {}, 'Status'),
              h('th', {}, ''),
            )),
            h('tbody', {}, bookings.map((b) => h('tr', {},
              h('td', {}, b.person_name || b.contact_name || '—'),
              h('td', {}, b.resource_name,
                b.quantity > 1 ? h('span', { class: 'muted small' }, ` ×${b.quantity}`) : null),
              h('td', {}, b.arrival),
              h('td', {}, b.departure),
              h('td', { class: 'num' }, money(b.amount_cents)),
              h('td', {}, statusPill(b)),
              h('td', {},
                b.status === 'cancelled' ? null : h('div', { class: 'actions', style: 'gap:6px' },
                  b.paid
                    ? null
                    : h('button', { class: 'small', onclick: () => confirm(b) }, 'Paid'),
                  h('button', { class: 'small ghost', onclick: () => cancel(b) }, 'Cancel'),
                )),
            ))),
          ),
      h('div', { class: 'actions', style: 'gap:8px;margin-top:10px' },
        h('button', { class: 'small ghost', onclick: sweep }, 'Release expired holds'),
      ),
    );
  }

  function draw() {
    render(h('div', {},
      h('h1', {}, 'Grounds'),
      h('p', { class: 'muted' },
        'Stalls, spots and arena time. This is the producer\'s own income — it '
        + 'does not go through the contestants\' payout.'),
      availabilityPanel(),
      bookingsPanel(),
    ));
  }

  await load();
}
