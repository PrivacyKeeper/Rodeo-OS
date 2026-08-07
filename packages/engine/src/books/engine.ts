/**
 * Closing the books.
 *
 * ---------------------------------------------------------------------------
 * THE MOMENT THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 * It is ten at night. The last steer has run. The secretary is tired, alone in
 * an arena office with a laptop, and the association's deadline is 11:59 p.m.
 * Mountain with a $100 fine on the other side of it. She has to reconcile a
 * payoff by hand and file it before she can go home.
 *
 * That is the moment this product wins or loses, and it is not the entry form.
 *
 * So the goal of this module is narrow and measurable: **the books are closed
 * and filed before the trailer leaves the grounds.** Everything here is judged
 * against the time between the last score going in and the secretary standing
 * up.
 *
 * ---------------------------------------------------------------------------
 * DESIGN RULES, IN ORDER OF IMPORTANCE
 * ---------------------------------------------------------------------------
 * 1. NEVER BLOCK ON SOMETHING THAT IS NOT WRONG. A secretary who cannot file
 *    at 11:40 because the software wants a sponsorship agreement uploaded will
 *    never open the software again. Only genuine defects — money that does not
 *    reconcile, runs nobody scored, a score still provisional — are blockers.
 *    Everything else is a warning and the close proceeds.
 *
 * 2. EVERY BLOCKER MUST NAME THE ROW AND THE FIX. "3 issues found" is useless
 *    at that hour. "Bareback R1: Tyler Hayes has no score" is a thing she can
 *    act on in ten seconds.
 *
 * 3. INTEGER CENTS THROUGHOUT, and the reconciliation is exact. If the payout
 *    lines do not sum to the purse the close is refused, because a book that
 *    balances by rounding is a book that does not balance.
 *
 * 4. NO CLOCK, NO I/O. Same as every other engine here. "Now" is passed in, so
 *    the deadline arithmetic is testable and reproducible.
 */

import { assertReconciles } from '../money.ts';

// ---------------------------------------------------------------------------
// Timezone arithmetic
//
// "11:59 p.m. Mountain Time" is a wall clock, not a duration. Turning it into
// an instant needs the zone's offset ON THAT DATE, which changes twice a year.
// Doing this with a fixed -0700 would file a rodeo an hour late every summer.
// ---------------------------------------------------------------------------

/** Offset in ms between a zone's wall clock and UTC at a given instant. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - utcMs;
}

/**
 * The instant at which a local wall time falls in a zone.
 *
 * Two passes: guess the offset from the naive UTC reading, then re-derive it
 * from the corrected instant. That second pass is what makes the daylight
 * saving changeover come out right.
 */
export function wallTimeToUtcMs(
  dateISO: string,
  localTime: string,
  timeZone: string,
): number {
  const [y, m, d] = dateISO.split('-').map(Number);
  const [hh, mm] = localTime.split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) {
    throw new Error(`Invalid date or time: '${dateISO}' '${localTime}'`);
  }
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  let utc = naive - zoneOffsetMs(naive, timeZone);
  utc = naive - zoneOffsetMs(utc, timeZone);
  return utc;
}

export interface FilingRule {
  /** '23:59'. Null when the association publishes no deadline. */
  local_time: string | null;
  timezone: string | null;
  /** Days after the final performance. 0 = the same night. */
  day_offset: number;
  late_fee_cents: number | null;
}

export interface FilingDeadline {
  /** ISO instant, or null when the association has no published deadline. */
  due_at: string | null;
  /** Negative once it has passed. */
  ms_remaining: number | null;
  passed: boolean;
  late_fee_cents: number | null;
}

/**
 * When this rodeo has to be filed.
 *
 * Returns nulls rather than inventing a deadline when the association does not
 * publish one. A made-up deadline shown to a committee as if it were the
 * association's is worse than no deadline at all.
 */
export function filingDeadline(
  lastPerformanceDate: string,
  rule: FilingRule,
  nowMs: number,
): FilingDeadline {
  if (!rule.local_time || !rule.timezone) {
    return { due_at: null, ms_remaining: null, passed: false, late_fee_cents: null };
  }
  const [y, m, d] = lastPerformanceDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + rule.day_offset));
  const dateISO = shifted.toISOString().slice(0, 10);
  const dueMs = wallTimeToUtcMs(dateISO, rule.local_time, rule.timezone);
  return {
    due_at: new Date(dueMs).toISOString(),
    ms_remaining: dueMs - nowMs,
    passed: nowMs > dueMs,
    late_fee_cents: rule.late_fee_cents,
  };
}

// ---------------------------------------------------------------------------
// The association's cut
// ---------------------------------------------------------------------------

export interface AssociationFeeSchedule {
  association_pct?: number;
  /** What the percentage is taken on. */
  basis?: 'added_plus_entries' | 'entries_only' | 'added_only';
  deducted_before_payoff?: boolean;
  remitted_with_results?: boolean;
}

/**
 * What the association takes off the top before the payoff.
 *
 * Read from the association profile as data. No association's percentage
 * appears anywhere in this file, deliberately: the day a body changes its
 * number, that is a row, not a release.
 */
export function associationDeduction(
  schedule: AssociationFeeSchedule | null | undefined,
  addedCents: number,
  entryFeesCents: number,
): number {
  if (!schedule?.association_pct) return 0;
  const basis =
    schedule.basis === 'entries_only'
      ? entryFeesCents
      : schedule.basis === 'added_only'
        ? addedCents
        : addedCents + entryFeesCents;
  return Math.round(basis * schedule.association_pct);
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type BlockerCode =
  | 'UNSCORED_RUN'
  | 'PROVISIONAL_SCORE'
  | 'MISSING_RESULTS'
  | 'PAYOUT_MISMATCH'
  | 'UNPAID_ENTRY'
  | 'COMPLIANCE_BLOCKER'
  | 'UNDRAWN_ENTRY';

export type WarningCode =
  | 'PERSONNEL_SHORTFALL'
  | 'COMPLIANCE_OVERDUE'
  | 'UNVERIFIED_RULES'
  | 'MISSING_HORSE'
  | 'DEADLINE_NEAR'
  | 'DEADLINE_PASSED'
  | 'NO_RESULTS_AT_ALL';

export interface BooksIssue<C extends string> {
  code: C;
  /** Where it is, in words a secretary can act on. */
  where: string;
  message: string;
  /** What to do about it, in one line. */
  fix: string;
  entity_id?: string;
}

export interface BooksTotals {
  entries: number;
  live_entries: number;
  scratched_entries: number;
  fees_charged_cents: number;
  fees_collected_cents: number;
  added_money_cents: number;
  gross_purse_cents: number;
  association_deduction_cents: number;
  net_purse_cents: number;
  paid_out_cents: number;
  ground_money_cents: number;
  day_money_cents: number;
  /** Positive means money still to disburse; negative means over-paid. */
  unpaid_purse_cents: number;
}

export interface BooksStatus {
  ready: boolean;
  blockers: BooksIssue<BlockerCode>[];
  warnings: BooksIssue<WarningCode>[];
  totals: BooksTotals;
  deadline: FilingDeadline;
}

// ---- Input ---------------------------------------------------------------

export interface BooksEntryRow {
  entry_id: string;
  rodeo_event_id: string;
  event_label: string;
  contestant_name: string;
  go_round: number;
  /** confirmed / drawn / competed / scratched / turned_out / no_show / pending */
  status: string;
  draw_position: number | null;
  /** null / 'provisional' / 'official' / 'reride' / 'dq' */
  score_status: string | null;
  fee_charged_cents: number;
  fee_collected_cents: number;
  /** Only meaningful for events run on a contestant's own horse. */
  needs_horse: boolean;
  horse_id: string | null;
}

export interface BooksEventRow {
  rodeo_event_id: string;
  event_label: string;
  go_rounds: number[];
  added_money_cents: number;
  entry_fees_cents: number;
  /** Payout lines already written for this event, in cents. */
  paid_out_cents: number;
  ground_money_cents: number;
  day_money_cents: number;
  /** Rounds that have an official results row. */
  official_result_rounds: number[];
  /** True once the average/aggregate placing is official, where one applies. */
  average_official: boolean;
  has_average: boolean;
}

export interface BooksComplianceRow {
  code: string;
  label: string;
  /** 'document' | 'insurance' | 'escrow' | 'fee' | 'personnel' | 'welfare' | 'filing' */
  requirement_type: string;
  status: string;
  blocks_close: boolean;
  due_on: string | null;
}

export interface BooksInput {
  last_performance_date: string;
  now_ms: number;
  filing: FilingRule;
  fee_schedule?: AssociationFeeSchedule | null;
  /** False when the association profile's values are unsourced. */
  rules_verified?: boolean;
  association_code?: string | null;
  entries: BooksEntryRow[];
  events: BooksEventRow[];
  compliance?: BooksComplianceRow[];
  personnel_shortfall?: { role: string; required: number; assigned: number }[];
}

const LIVE_STATUSES = new Set(['confirmed', 'drawn', 'competed']);
const SCRATCH_STATUSES = new Set(['scratched', 'turned_out', 'no_show']);

/**
 * Can the books be closed, and if not, exactly what is wrong.
 */
export function checkBooks(input: BooksInput): BooksStatus {
  const blockers: BooksIssue<BlockerCode>[] = [];
  const warnings: BooksIssue<WarningCode>[] = [];

  // ---- Runs ---------------------------------------------------------------
  for (const e of input.entries) {
    const where = `${e.event_label} R${e.go_round}: ${e.contestant_name}`;

    if (SCRATCH_STATUSES.has(e.status)) continue;

    if (!LIVE_STATUSES.has(e.status)) {
      // 'pending' and anything unrecognised: unconfirmed entries are not runs
      // and must not hold up a close.
      continue;
    }

    if (e.draw_position === null) {
      blockers.push({
        code: 'UNDRAWN_ENTRY',
        where,
        message: 'Entered and confirmed but never drawn, so nobody ran.',
        fix: 'Scratch the entry, or run the draw and score the run.',
        entity_id: e.entry_id,
      });
      continue;
    }

    if (e.score_status === null) {
      blockers.push({
        code: 'UNSCORED_RUN',
        where,
        message: 'No score recorded and not marked as a turnout or scratch.',
        fix: 'Enter the time or score, or mark the run as a turnout.',
        entity_id: e.entry_id,
      });
      continue;
    }

    if (e.score_status === 'provisional') {
      blockers.push({
        code: 'PROVISIONAL_SCORE',
        where,
        message: 'Score is still provisional, so the placings are not final.',
        fix: 'Make the score official, or correct it and then make it official.',
        entity_id: e.entry_id,
      });
    }

    if (e.needs_horse && !e.horse_id) {
      warnings.push({
        code: 'MISSING_HORSE',
        where,
        message: 'No horse recorded on the entry.',
        fix: 'Add the horse so the run counts towards its record. Not required to file.',
        entity_id: e.entry_id,
      });
    }
  }

  // ---- Money and results, per event --------------------------------------
  let feesCharged = 0;
  let feesCollected = 0;
  let addedMoney = 0;
  let grossPurse = 0;
  let deduction = 0;
  let paidOut = 0;
  let groundMoney = 0;
  let dayMoney = 0;

  for (const e of input.entries) {
    feesCharged += e.fee_charged_cents;
    feesCollected += e.fee_collected_cents;
    // Only money owed by people who are actually in the pot. An entry still
    // sitting at 'pending' never got confirmed and never ran — chasing its fee
    // at eleven at night is chasing a fee that was never due.
    if (LIVE_STATUSES.has(e.status) && e.fee_collected_cents < e.fee_charged_cents) {
      blockers.push({
        code: 'UNPAID_ENTRY',
        where: `${e.event_label}: ${e.contestant_name}`,
        message: `Entry fee short by ${cents(
          e.fee_charged_cents - e.fee_collected_cents,
        )}.`,
        fix: 'Take the payment, or scratch the entry so it is not in the pot.',
        entity_id: e.entry_id,
      });
    }
  }

  for (const ev of input.events) {
    addedMoney += ev.added_money_cents;
    const eventGross = ev.added_money_cents + ev.entry_fees_cents;
    grossPurse += eventGross;

    const eventDeduction = associationDeduction(
      input.fee_schedule,
      ev.added_money_cents,
      ev.entry_fees_cents,
    );
    deduction += eventDeduction;

    paidOut += ev.paid_out_cents;
    groundMoney += ev.ground_money_cents;
    dayMoney += ev.day_money_cents;

    const scoredRounds = new Set(
      input.entries
        .filter(
          (e) =>
            e.rodeo_event_id === ev.rodeo_event_id &&
            e.score_status !== null &&
            !SCRATCH_STATUSES.has(e.status),
        )
        .map((e) => e.go_round),
    );

    for (const round of ev.go_rounds) {
      if (!scoredRounds.has(round)) continue;
      if (!ev.official_result_rounds.includes(round)) {
        blockers.push({
          code: 'MISSING_RESULTS',
          where: `${ev.event_label} R${round}`,
          message: 'Runs are scored but the placings have not been made official.',
          fix: 'Compute results for the round, then mark them official.',
          entity_id: ev.rodeo_event_id,
        });
      }
    }

    if (ev.has_average && scoredRounds.size > 0 && !ev.average_official) {
      blockers.push({
        code: 'MISSING_RESULTS',
        where: `${ev.event_label} — average`,
        message: 'The average has not been placed.',
        fix: 'Compute the average and mark it official.',
        entity_id: ev.rodeo_event_id,
      });
    }

    // The reconciliation. Everything that left the pot must equal what was in
    // it, to the cent — this is the same invariant the payout engine holds and
    // it is checked again here because a payout can be written by more than
    // one route.
    const netPurse = eventGross - eventDeduction;
    const disbursed = ev.paid_out_cents + ev.ground_money_cents + ev.day_money_cents;
    if (disbursed > 0 && disbursed !== netPurse) {
      blockers.push({
        code: 'PAYOUT_MISMATCH',
        where: ev.event_label,
        message:
          `Payout lines total ${cents(disbursed)} against a net purse of ` +
          `${cents(netPurse)} — out by ${cents(Math.abs(netPurse - disbursed))}.`,
        fix: 'Recalculate the payout for this event. Do not adjust a line by hand.',
        entity_id: ev.rodeo_event_id,
      });
    }
  }

  const netPurse = grossPurse - deduction;
  const disbursedTotal = paidOut + groundMoney + dayMoney;

  if (input.events.length > 0 && disbursedTotal === 0) {
    warnings.push({
      code: 'NO_RESULTS_AT_ALL',
      where: 'This rodeo',
      message: 'Nothing has been paid out.',
      fix: 'Expected for a rodeo with no added money or an unpaid jackpot. Otherwise, run the payouts.',
    });
  }

  // ---- Compliance ---------------------------------------------------------
  for (const c of input.compliance ?? []) {
    const done = c.status === 'satisfied' || c.status === 'waived';
    if (done) continue;

    // A filing requirement can never block a close, whatever the requirement
    // says, because filing happens AFTER closing. Seeding the PRCA
    // results-filed requirement as blocking created exactly that deadlock: the
    // books could not close until the results were filed, and the results
    // could not be filed until the books closed. Caught by the integration
    // tests. The seed is fixed; this guard means a producer writing their own
    // requirement cannot rebuild the same trap.
    const blocks = c.blocks_close && c.requirement_type !== 'filing';

    if (blocks) {
      blockers.push({
        code: 'COMPLIANCE_BLOCKER',
        where: c.label,
        message: 'A requirement that has to be met before the books close.',
        fix: 'Complete it, or waive it with a reason on the record.',
        entity_id: c.code,
      });
    } else {
      warnings.push({
        code: 'COMPLIANCE_OVERDUE',
        where: c.label,
        message: c.due_on ? `Outstanding, was due ${c.due_on}.` : 'Outstanding.',
        fix: 'Not required to file. Clear it when there is time.',
        entity_id: c.code,
      });
    }
  }

  for (const p of input.personnel_shortfall ?? []) {
    warnings.push({
      code: 'PERSONNEL_SHORTFALL',
      where: p.role,
      message: `${p.assigned} of ${p.required} assigned.`,
      fix: 'Record who actually worked the rodeo. Does not stop the filing.',
    });
  }

  if (input.association_code && input.rules_verified === false) {
    warnings.push({
      code: 'UNVERIFIED_RULES',
      where: input.association_code,
      message:
        'This association profile carries values taken from secondary sources.',
      fix: 'Check the deadline and the deduction against the rule book before relying on them.',
    });
  }

  // ---- The clock ----------------------------------------------------------
  const deadline = filingDeadline(
    input.last_performance_date,
    input.filing,
    input.now_ms,
  );
  if (deadline.due_at) {
    if (deadline.passed) {
      warnings.push({
        code: 'DEADLINE_PASSED',
        where: 'Filing deadline',
        message: `Passed at ${deadline.due_at}.${
          deadline.late_fee_cents ? ` Late fee ${cents(deadline.late_fee_cents)}.` : ''
        }`,
        fix: 'File anyway. Late is recoverable; unfiled is not.',
      });
    } else if ((deadline.ms_remaining ?? 0) < 2 * 60 * 60 * 1000) {
      warnings.push({
        code: 'DEADLINE_NEAR',
        where: 'Filing deadline',
        message: `Due at ${deadline.due_at} — under two hours.`,
        fix: 'Clear the blockers below and file.',
      });
    }
  }

  const totals: BooksTotals = {
    entries: input.entries.length,
    live_entries: input.entries.filter((e) => LIVE_STATUSES.has(e.status)).length,
    scratched_entries: input.entries.filter((e) => SCRATCH_STATUSES.has(e.status))
      .length,
    fees_charged_cents: feesCharged,
    fees_collected_cents: feesCollected,
    added_money_cents: addedMoney,
    gross_purse_cents: grossPurse,
    association_deduction_cents: deduction,
    net_purse_cents: netPurse,
    paid_out_cents: paidOut,
    ground_money_cents: groundMoney,
    day_money_cents: dayMoney,
    unpaid_purse_cents: netPurse - disbursedTotal,
  };

  // Post-condition on our own arithmetic, not on the data: if the totals we
  // just built do not add up, the bug is here and it must not be reported as
  // a clean set of books.
  assertReconciles(
    [totals.net_purse_cents, totals.association_deduction_cents],
    totals.gross_purse_cents,
    'books totals',
  );

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    totals,
    deadline,
  };
}

function cents(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(
    abs % 100,
  ).padStart(2, '0')}`;
}

/**
 * A one-page settlement summary, fixed width, for the producer's folder and
 * the association's envelope.
 */
export function renderBooksText(
  status: BooksStatus,
  rodeoName: string,
  width = 72,
): string {
  const t = status.totals;
  const row = (label: string, value: string) =>
    label.padEnd(width - value.length - 2, '.') + '  ' + value;
  const out: string[] = [];

  out.push(rodeoName.toUpperCase());
  out.push('SETTLEMENT SUMMARY');
  out.push('='.repeat(width));
  out.push(row('Entries', String(t.entries)));
  out.push(row('  competing', String(t.live_entries)));
  out.push(row('  scratched / turned out', String(t.scratched_entries)));
  out.push('');
  out.push(row('Entry fees charged', cents(t.fees_charged_cents)));
  out.push(row('Entry fees collected', cents(t.fees_collected_cents)));
  out.push(row('Added money', cents(t.added_money_cents)));
  out.push('-'.repeat(width));
  out.push(row('Gross purse', cents(t.gross_purse_cents)));
  out.push(row('Association deduction', cents(-t.association_deduction_cents)));
  out.push(row('Net purse', cents(t.net_purse_cents)));
  out.push('');
  out.push(row('Paid — placings', cents(t.paid_out_cents)));
  out.push(row('Paid — ground money', cents(t.ground_money_cents)));
  out.push(row('Paid — day money', cents(t.day_money_cents)));
  out.push('-'.repeat(width));
  out.push(row('Still to disburse', cents(t.unpaid_purse_cents)));
  out.push('='.repeat(width));

  if (status.deadline.due_at) {
    out.push(`Filing deadline: ${status.deadline.due_at}`);
  }
  out.push(status.ready ? 'READY TO CLOSE' : `${status.blockers.length} BLOCKER(S)`);
  for (const b of status.blockers) {
    out.push(`  ✗ ${b.where} — ${b.message}`);
    out.push(`      → ${b.fix}`);
  }
  for (const w of status.warnings) {
    out.push(`  ! ${w.where} — ${w.message}`);
  }
  return out.join('\n');
}
