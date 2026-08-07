import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  associationDeduction,
  checkBooks,
  filingDeadline,
  renderBooksText,
  toCents,
  wallTimeToUtcMs,
  type BooksEntryRow,
  type BooksEventRow,
  type BooksInput,
} from '../src/index.ts';

const PRCA_FILING = {
  local_time: '23:59',
  timezone: 'America/Denver',
  day_offset: 0,
  late_fee_cents: 10000,
};

function row(over: Partial<BooksEntryRow> & { entry_id: string }): BooksEntryRow {
  return {
    rodeo_event_id: 'ev-1',
    event_label: 'Bareback Riding',
    contestant_name: 'Tyler Hayes',
    go_round: 1,
    status: 'competed',
    draw_position: 1,
    score_status: 'official',
    fee_charged_cents: toCents(100),
    fee_collected_cents: toCents(100),
    needs_horse: false,
    horse_id: null,
    ...over,
  };
}

function event(over: Partial<BooksEventRow> = {}): BooksEventRow {
  return {
    rodeo_event_id: 'ev-1',
    event_label: 'Bareback Riding',
    go_rounds: [1],
    added_money_cents: toCents(1000),
    entry_fees_cents: toCents(1000),
    paid_out_cents: toCents(2000),
    ground_money_cents: 0,
    day_money_cents: 0,
    official_result_rounds: [1],
    average_official: false,
    has_average: false,
    ...over,
  };
}

function input(over: Partial<BooksInput> = {}): BooksInput {
  return {
    last_performance_date: '2026-09-12',
    now_ms: Date.parse('2026-09-12T22:00:00-06:00'),
    filing: { local_time: null, timezone: null, day_offset: 0, late_fee_cents: null },
    entries: [row({ entry_id: 'a' })],
    events: [event()],
    ...over,
  };
}

describe('wall time to instant', () => {
  it('resolves a local wall clock through the zone offset', () => {
    // 11:59pm Mountain on 12 Sep 2026 is inside daylight time: UTC-6.
    const ms = wallTimeToUtcMs('2026-09-12', '23:59', 'America/Denver');
    assert.equal(new Date(ms).toISOString(), '2026-09-13T05:59:00.000Z');
  });

  it('gets the standard-time side of the changeover right too', () => {
    // A fixed -0700 would file an hour late all summer; a fixed -0600 would be
    // an hour out all winter. December is UTC-7.
    const ms = wallTimeToUtcMs('2026-12-12', '23:59', 'America/Denver');
    assert.equal(new Date(ms).toISOString(), '2026-12-13T06:59:00.000Z');
  });

  it('handles a zone that does not observe daylight saving', () => {
    const summer = wallTimeToUtcMs('2026-07-01', '12:00', 'America/Phoenix');
    const winter = wallTimeToUtcMs('2026-01-01', '12:00', 'America/Phoenix');
    assert.equal(new Date(summer).toISOString(), '2026-07-01T19:00:00.000Z');
    assert.equal(new Date(winter).toISOString(), '2026-01-01T19:00:00.000Z');
  });

  it('rejects nonsense rather than silently producing a date', () => {
    assert.throws(() => wallTimeToUtcMs('not-a-date', '23:59', 'UTC'));
  });
});

describe('filing deadline', () => {
  it('is the same night when the offset is zero', () => {
    const d = filingDeadline('2026-09-12', PRCA_FILING, Date.parse('2026-09-12T20:00:00-06:00'));
    assert.equal(d.due_at, '2026-09-13T05:59:00.000Z');
    assert.equal(d.passed, false);
    assert.equal(d.late_fee_cents, 10000);
  });

  it('knows when it has gone', () => {
    const d = filingDeadline('2026-09-12', PRCA_FILING, Date.parse('2026-09-13T07:00:00Z'));
    assert.equal(d.passed, true);
    assert.ok((d.ms_remaining ?? 0) < 0);
  });

  it('shifts by the day offset', () => {
    const d = filingDeadline(
      '2026-09-12',
      { ...PRCA_FILING, day_offset: 3 },
      Date.parse('2026-09-12T20:00:00Z'),
    );
    assert.equal(d.due_at?.slice(0, 10), '2026-09-16');
  });

  it('invents nothing when the association publishes no deadline', () => {
    // A made-up deadline shown to a committee as if it were the association's
    // is worse than no deadline at all.
    const d = filingDeadline(
      '2026-09-12',
      { local_time: null, timezone: null, day_offset: 0, late_fee_cents: null },
      Date.now(),
    );
    assert.equal(d.due_at, null);
    assert.equal(d.ms_remaining, null);
    assert.equal(d.passed, false);
  });
});

describe('association deduction', () => {
  it('takes the published percentage off added money plus entry fees', () => {
    const d = associationDeduction(
      { association_pct: 0.06, basis: 'added_plus_entries' },
      toCents(5000),
      toCents(7500),
    );
    assert.equal(d, toCents(750));
  });

  it('respects a narrower basis', () => {
    assert.equal(
      associationDeduction({ association_pct: 0.06, basis: 'entries_only' }, toCents(5000), toCents(1000)),
      toCents(60),
    );
    assert.equal(
      associationDeduction({ association_pct: 0.06, basis: 'added_only' }, toCents(5000), toCents(1000)),
      toCents(300),
    );
  });

  it('is zero for an unsanctioned rodeo', () => {
    assert.equal(associationDeduction(null, toCents(5000), toCents(1000)), 0);
    assert.equal(associationDeduction({}, toCents(5000), toCents(1000)), 0);
  });
});

describe('close the books', () => {
  it('is ready when nothing is wrong', () => {
    const s = checkBooks(input());
    assert.equal(s.ready, true);
    assert.deepEqual(s.blockers, []);
  });

  it('blocks a run nobody scored, and names the contestant', () => {
    // "3 issues found" is useless at eleven at night.
    const s = checkBooks(
      input({ entries: [row({ entry_id: 'a', score_status: null })] }),
    );
    assert.equal(s.ready, false);
    assert.equal(s.blockers[0].code, 'UNSCORED_RUN');
    assert.match(s.blockers[0].where, /Tyler Hayes/);
    assert.ok(s.blockers[0].fix.length > 0);
  });

  it('blocks a provisional score', () => {
    const s = checkBooks(
      input({ entries: [row({ entry_id: 'a', score_status: 'provisional' })] }),
    );
    assert.equal(s.blockers[0].code, 'PROVISIONAL_SCORE');
  });

  it('blocks an entry that was confirmed and never drawn', () => {
    const s = checkBooks(
      input({
        entries: [row({ entry_id: 'a', draw_position: null, score_status: null })],
      }),
    );
    assert.equal(s.blockers[0].code, 'UNDRAWN_ENTRY');
  });

  it('does not block on a turnout — that run is accounted for', () => {
    const s = checkBooks(
      input({
        entries: [
          row({ entry_id: 'a', status: 'turned_out', score_status: null, fee_collected_cents: 0 }),
        ],
        events: [event({ official_result_rounds: [], paid_out_cents: 0 })],
      }),
    );
    assert.equal(s.ready, true);
    assert.equal(s.totals.scratched_entries, 1);
  });

  it('does not block on an unconfirmed entry', () => {
    const s = checkBooks(
      input({
        entries: [row({ entry_id: 'a', status: 'pending', score_status: null, fee_collected_cents: 0 })],
        events: [event({ official_result_rounds: [], paid_out_cents: 0 })],
      }),
    );
    assert.equal(s.ready, true);
  });

  it('blocks scores that were never made official', () => {
    const s = checkBooks(input({ events: [event({ official_result_rounds: [] })] }));
    assert.ok(s.blockers.some((b) => b.code === 'MISSING_RESULTS'));
  });

  it('blocks an unplaced average', () => {
    const s = checkBooks(
      input({ events: [event({ has_average: true, average_official: false })] }),
    );
    assert.ok(s.blockers.some((b) => /average/.test(b.where)));
  });

  it('blocks a payout that does not reconcile, and says by how much', () => {
    // A book that balances by rounding is a book that does not balance.
    const s = checkBooks(
      input({ events: [event({ paid_out_cents: toCents(1999.99) })] }),
    );
    const mismatch = s.blockers.find((b) => b.code === 'PAYOUT_MISMATCH');
    assert.ok(mismatch);
    assert.match(mismatch.message, /\$0\.01/);
  });

  it('reconciles once the association takes its cut', () => {
    const s = checkBooks(
      input({
        fee_schedule: { association_pct: 0.06, basis: 'added_plus_entries' },
        events: [event({ paid_out_cents: toCents(1880) })],
      }),
    );
    assert.equal(s.ready, true);
    assert.equal(s.totals.association_deduction_cents, toCents(120));
    assert.equal(s.totals.net_purse_cents, toCents(1880));
    assert.equal(s.totals.unpaid_purse_cents, 0);
  });

  it('blocks an entry fee that was never collected', () => {
    const s = checkBooks(
      input({ entries: [row({ entry_id: 'a', fee_collected_cents: toCents(40) })] }),
    );
    const unpaid = s.blockers.find((b) => b.code === 'UNPAID_ENTRY');
    assert.ok(unpaid);
    assert.match(unpaid.message, /\$60\.00/);
  });

  it('blocks a compliance item that says it blocks, and only that one', () => {
    const s = checkBooks(
      input({
        compliance: [
          { code: 'PRCA:escrow_purse', label: 'Purse escrowed', requirement_type: 'escrow', status: 'pending', blocks_close: true, due_on: null },
          { code: 'PRCA:sponsorship_agreement', label: 'Sponsorship agreement', requirement_type: 'document', status: 'pending', blocks_close: false, due_on: '2026-06-14' },
        ],
      }),
    );
    assert.equal(s.blockers.filter((b) => b.code === 'COMPLIANCE_BLOCKER').length, 1);
    assert.ok(s.warnings.some((w) => w.code === 'COMPLIANCE_OVERDUE'));
  });

  it('never blocks on paperwork that is not wrong', () => {
    // The rule that decides whether a secretary uses this product twice.
    const s = checkBooks(
      input({
        compliance: [
          { code: 'x', label: 'Sponsorship agreement', requirement_type: 'document', status: 'pending', blocks_close: false, due_on: '2026-06-14' },
          { code: 'y', label: 'Livestock welfare form', requirement_type: 'welfare', status: 'pending', blocks_close: false, due_on: '2026-06-14' },
        ],
        personnel_shortfall: [{ role: 'pickup_rider', required: 2, assigned: 1 }],
        rules_verified: false,
        association_code: 'PRCA',
      }),
    );
    assert.equal(s.ready, true, 'paperwork must never stop a filing');
    assert.ok(s.warnings.length >= 4);
  });

  it('warns rather than blocks when a horse was not recorded', () => {
    const s = checkBooks(
      input({ entries: [row({ entry_id: 'a', needs_horse: true, horse_id: null })] }),
    );
    assert.equal(s.ready, true);
    assert.ok(s.warnings.some((w) => w.code === 'MISSING_HORSE'));
  });

  it('warns when the deadline is close, and when it has gone', () => {
    const near = checkBooks(
      input({
        filing: PRCA_FILING,
        now_ms: Date.parse('2026-09-13T05:00:00Z'), // 59 minutes to go
      }),
    );
    assert.ok(near.warnings.some((w) => w.code === 'DEADLINE_NEAR'));

    const gone = checkBooks(
      input({ filing: PRCA_FILING, now_ms: Date.parse('2026-09-13T08:00:00Z') }),
    );
    const passed = gone.warnings.find((w) => w.code === 'DEADLINE_PASSED');
    assert.ok(passed);
    assert.match(passed.fix, /File anyway/);
  });

  it('a passed deadline never blocks the filing', () => {
    // Late is recoverable. Unfiled is not.
    const s = checkBooks(
      input({ filing: PRCA_FILING, now_ms: Date.parse('2026-10-01T00:00:00Z') }),
    );
    assert.equal(s.ready, true);
  });

  it('totals reconcile exactly across many events', () => {
    const events = Array.from({ length: 9 }, (_, i) =>
      event({
        rodeo_event_id: `ev-${i}`,
        event_label: `Event ${i}`,
        added_money_cents: toCents(1000 + i * 137),
        entry_fees_cents: toCents(613 + i * 91),
        official_result_rounds: [1],
        paid_out_cents: 0,
      }),
    );
    const s = checkBooks(input({ entries: [], events }));
    assert.equal(
      s.totals.net_purse_cents + s.totals.association_deduction_cents,
      s.totals.gross_purse_cents,
    );
  });

  it('renders a settlement summary a producer can file', () => {
    const text = renderBooksText(
      checkBooks(
        input({
          fee_schedule: { association_pct: 0.06, basis: 'added_plus_entries' },
          filing: PRCA_FILING,
          events: [event({ paid_out_cents: toCents(1880) })],
        }),
      ),
      'Ada Roundup',
    );
    assert.match(text, /ADA ROUNDUP/);
    assert.match(text, /Association deduction/);
    assert.match(text, /READY TO CLOSE/);
    assert.match(text, /Filing deadline/);
  });

  it('a filing requirement can never block the close', () => {
    // The deadlock the integration tests found: the books could not close
    // until the results were filed, and the results could not be filed until
    // the books closed. Guarded here so a producer writing their own
    // requirement cannot rebuild it.
    const s = checkBooks(
      input({
        compliance: [
          {
            code: 'PRCA:results_filed',
            label: 'Results filed with the association',
            requirement_type: 'filing',
            status: 'pending',
            blocks_close: true,
            due_on: null,
          },
        ],
      }),
    );
    assert.equal(s.ready, true, 'filing happens after closing, so it cannot gate it');
    assert.ok(s.warnings.some((w) => w.code === 'COMPLIANCE_OVERDUE'));
  });

  it('is deterministic', () => {
    const i = input();
    assert.deepEqual(checkBooks(i), checkBooks(i));
  });
});
