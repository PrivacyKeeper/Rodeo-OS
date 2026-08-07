import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkEntryEligibility,
  classifyTurnout,
  quoteEntryFees,
  toCents,
} from '../src/index.ts';

// ===========================================================================
// What a contestant owes
// ===========================================================================

describe('quoteEntryFees', () => {
  it('itemises a plain entry', () => {
    const q = quoteEntryFees({
      entry_fee_cents: toCents(50),
      stock_charge_cents: toCents(25),
      office_fee_cents: toCents(5),
    });
    assert.equal(q.total_cents, toCents(80));
    assert.equal(q.to_purse_cents, toCents(50), 'only the entry fee makes the purse');
    assert.deepEqual(
      q.lines.map((l) => l.type),
      ['entry_fee', 'stock_charge', 'office_fee'],
    );
  });

  it('shows where every dollar goes', () => {
    const q = quoteEntryFees({
      entry_fee_cents: toCents(50),
      stock_charge_cents: toCents(25),
      office_fee_cents: toCents(5),
      sanctioning_fee_cents: toCents(10),
    });
    const dest = new Map(q.lines.map((l) => [l.type, l.destination]));
    assert.equal(dest.get('entry_fee'), 'purse');
    assert.equal(dest.get('stock_charge'), 'stock_contractor');
    assert.equal(dest.get('office_fee'), 'producer');
    assert.equal(dest.get('sanctioning_fee'), 'association');
  });

  it('TEAM ROPING: the desk collects both ends at once', () => {
    const q = quoteEntryFees({
      entry_fee_cents: toCents(50),
      office_fee_cents: toCents(5),
      paying_ends: 2,
    });
    assert.equal(q.total_cents, toCents(110), 'two entry fees and two office fees');
    assert.equal(q.to_purse_cents, toCents(100), 'both fees build the purse');
  });

  it('a sidepot is bought once, not once per end', () => {
    const q = quoteEntryFees({
      entry_fee_cents: toCents(50),
      paying_ends: 2,
      sidepots: [{ id: 'sp1', name: '$20 Incentive', buy_in_cents: toCents(20) }],
    });
    assert.equal(q.to_sidepots_cents, toCents(20));
    assert.equal(q.total_cents, toCents(120));
  });

  it('charges a late fee on a day-of entry', () => {
    const q = quoteEntryFees({
      entry_fee_cents: toCents(50),
      late_fee_cents: toCents(15),
      is_late: true,
    });
    assert.equal(q.total_cents, toCents(65));
    assert.ok(q.lines.some((l) => l.type === 'late_fee'));
  });

  it('warns rather than inventing a late fee that was never configured', () => {
    const q = quoteEntryFees({ entry_fee_cents: toCents(50), is_late: true });
    assert.equal(q.total_cents, toCents(50));
    assert.ok(q.issues.some((i) => i.code === 'LATE_WITHOUT_FEE'));
  });

  it('refuses a negative entry fee', () => {
    const q = quoteEntryFees({ entry_fee_cents: -100 });
    assert.ok(q.issues.some((i) => i.code === 'NEGATIVE_FEE'));
    assert.equal(q.total_cents, 0);
  });

  it('the same quote twice is identical', () => {
    const input = {
      entry_fee_cents: toCents(75),
      stock_charge_cents: toCents(30),
      paying_ends: 2,
      sidepots: [{ id: 'a', name: 'Pot', buy_in_cents: toCents(20) }],
    };
    assert.deepEqual(quoteEntryFees(input), quoteEntryFees(input));
  });
});

// ===========================================================================
// Can they enter?
// ===========================================================================

const base = {
  rodeo_status: 'entries_open',
  allow_online_entry: true,
  now: '2026-09-01T12:00:00Z',
  existing_entries: 0,
  max_entries_per_contestant: 1,
};

describe('checkEntryEligibility', () => {
  it('lets a clean entry through', () => {
    const r = checkEntryEligibility(base);
    assert.equal(r.eligible, true);
    assert.equal(r.is_late, false);
  });

  it('refuses a rodeo that is not taking entries', () => {
    const r = checkEntryEligibility({ ...base, rodeo_status: 'draft' });
    assert.equal(r.eligible, false);
    assert.ok(r.issues.some((i) => i.code === 'ENTRIES_NOT_OPEN'));
  });

  it('refuses online entry when the producer has turned it off', () => {
    const r = checkEntryEligibility({ ...base, allow_online_entry: false });
    assert.equal(r.eligible, false);
    assert.ok(r.issues.some((i) => i.code === 'ONLINE_ENTRY_CLOSED'));
  });

  it('lets the SECRETARY enter somebody when online entry is off', () => {
    const r = checkEntryEligibility({
      ...base,
      allow_online_entry: false,
      entered_by_staff: true,
    });
    assert.equal(r.eligible, true);
  });

  it('refuses a contestant entering before books open', () => {
    const r = checkEntryEligibility({ ...base, books_open_at: '2026-09-02T00:00:00Z' });
    assert.equal(r.eligible, false);
    assert.ok(r.issues.some((i) => i.code === 'BOOKS_NOT_OPEN'));
  });

  it('refuses a contestant entering after books close', () => {
    const r = checkEntryEligibility({ ...base, books_close_at: '2026-08-31T00:00:00Z' });
    assert.equal(r.eligible, false);
    assert.ok(r.issues.some((i) => i.code === 'BOOKS_CLOSED'));
  });

  it('DAY-OF: staff can enter after books close, and it is flagged late', () => {
    const r = checkEntryEligibility({
      ...base,
      books_close_at: '2026-08-31T00:00:00Z',
      entered_by_staff: true,
    });
    assert.equal(r.eligible, true);
    assert.equal(r.is_late, true, 'so a late fee applies');
  });

  it('enforces the per-contestant entry limit', () => {
    const capped = checkEntryEligibility({
      ...base,
      existing_entries: 1,
      max_entries_per_contestant: 1,
    });
    assert.equal(capped.eligible, false);
    assert.ok(capped.issues.some((i) => i.code === 'ENTRY_LIMIT_REACHED'));

    // A roping that lets people enter three times.
    const roping = checkEntryEligibility({
      ...base,
      existing_entries: 2,
      max_entries_per_contestant: 3,
    });
    assert.equal(roping.eligible, true);
  });

  it('blocks on an unsigned waiver', () => {
    const r = checkEntryEligibility({
      ...base,
      unsigned_waivers: ['Liability Release'],
    });
    assert.equal(r.eligible, false);
    assert.ok(r.issues.some((i) => i.code === 'WAIVER_UNSIGNED'));
  });

  it('blocks a minor with no guardian consent', () => {
    const r = checkEntryEligibility({ ...base, minor_without_consent: true });
    assert.equal(r.eligible, false);
    assert.ok(r.issues.some((i) => i.code === 'MINOR_WITHOUT_CONSENT'));
  });

  it('blocks on a membership problem and says what it is', () => {
    const r = checkEntryEligibility({
      ...base,
      membership_problem: 'PRCA card expired 2026-01-31.',
    });
    assert.equal(r.eligible, false);
    const issue = r.issues.find((i) => i.code === 'MEMBERSHIP_PROBLEM');
    assert.match(issue!.message, /expired/);
  });

  it('reports EVERY problem at once, not one at a time', () => {
    const r = checkEntryEligibility({
      ...base,
      rodeo_status: 'draft',
      existing_entries: 5,
      unsigned_waivers: ['Liability Release', 'Media Consent'],
      minor_without_consent: true,
    });
    assert.equal(r.eligible, false);
    assert.ok(r.issues.length >= 5, `only ${r.issues.length} problems reported`);
  });
});

// ===========================================================================
// Turnouts
// ===========================================================================

describe('classifyTurnout', () => {
  it('30+ hours notice is a clean turnout with the fees back', () => {
    const r = classifyTurnout({
      notified_at: '2026-09-01T00:00:00Z',
      performance_at: '2026-09-03T00:00:00Z', // 48h
      release_type: 'personal',
    });
    assert.equal(r.status, 'turned_out');
    assert.equal(r.fineable, false);
    assert.equal(r.refund_due, true);
    assert.equal(r.hours_notice, 48);
  });

  it('inside 30 hours is fineable', () => {
    const r = classifyTurnout({
      notified_at: '2026-09-02T12:00:00Z',
      performance_at: '2026-09-03T00:00:00Z', // 12h
      release_type: 'personal',
    });
    assert.equal(r.fineable, true);
    assert.equal(r.refund_due, false);
    assert.ok(r.issues.some((i) => i.code === 'SHORT_NOTICE'));
  });

  it('a medical release is excused however late it comes', () => {
    const r = classifyTurnout({
      notified_at: '2026-09-02T23:00:00Z',
      performance_at: '2026-09-03T00:00:00Z', // 1h
      release_type: 'medical',
    });
    assert.equal(r.status, 'medical_release');
    assert.equal(r.fineable, false);
    assert.equal(r.refund_due, true, 'a hurt contestant gets their money back');
  });

  it('a vet release on the horse is excused too', () => {
    const r = classifyTurnout({
      notified_at: '2026-09-02T23:00:00Z',
      performance_at: '2026-09-03T00:00:00Z',
      release_type: 'vet_release',
    });
    assert.equal(r.status, 'medical_release');
    assert.equal(r.fineable, false);
  });

  it('a producer can set their own notice period', () => {
    const r = classifyTurnout({
      notified_at: '2026-09-02T12:00:00Z',
      performance_at: '2026-09-03T00:00:00Z', // 12h
      release_type: 'personal',
      required_notice_hours: 6,
    });
    assert.equal(r.fineable, false, '12h clears a 6h requirement');
  });

  it('notice given AFTER the performance is short notice, not negative credit', () => {
    const r = classifyTurnout({
      notified_at: '2026-09-03T06:00:00Z',
      performance_at: '2026-09-03T00:00:00Z',
      release_type: 'personal',
    });
    assert.equal(r.fineable, true);
    assert.equal(r.refund_due, false);
    assert.ok(r.hours_notice < 0);
  });

  it('an unreadable timestamp is refused rather than guessed', () => {
    const r = classifyTurnout({
      notified_at: 'not-a-date',
      performance_at: '2026-09-03T00:00:00Z',
      release_type: 'personal',
    });
    assert.ok(r.issues.some((i) => i.code === 'BAD_TIMESTAMP'));
  });
});
