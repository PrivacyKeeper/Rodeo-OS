/**
 * What a contestant owes to enter.
 *
 * This is the number on the screen when somebody hits "enter", and the number
 * the secretary reads back over the phone. It has to be exact, itemised, and
 * the same every time — a contestant who is quoted $145 and charged $150 will
 * not enter again.
 *
 * Integer cents throughout, same as the payout engine.
 */

import type { ValidationIssue } from '../types/index.ts';

export interface FeeLine {
  /** A `fee_type` code from reference_options. */
  type: string;
  label: string;
  amount_cents: number;
  /** Who ends up with this money. Shown in the producer's settlement report. */
  destination: string;
}

export interface EntryFeeInput {
  entry_fee_cents: number;
  stock_charge_cents?: number;
  office_fee_cents?: number;
  /** Per-entry association or sanctioning charges. */
  sanctioning_fee_cents?: number;
  /** Charged when entering after books close. */
  late_fee_cents?: number;
  /** Sidepots and incentives the contestant opted into. */
  sidepots?: { id: string; name: string; buy_in_cents: number }[];
  /**
   * Team roping: both ropers pay. When a secretary enters a team in one go,
   * the desk collects both fees together.
   */
  paying_ends?: number;
  /** True when the entry arrives after books_close_at. */
  is_late?: boolean;
}

export interface EntryFeeQuote {
  lines: FeeLine[];
  /** Everything the contestant hands over. */
  total_cents: number;
  /** The part that goes into the purse rather than to fees. */
  to_purse_cents: number;
  /** The part that goes into sidepot purses. */
  to_sidepots_cents: number;
  issues: ValidationIssue[];
}

/**
 * Itemise an entry.
 *
 * Nothing is rolled into a single "entry fee" figure: the contestant sees the
 * stock charge and the office fee separately because they are separate money
 * going to separate places, and because a producer who cannot show the
 * breakdown gets asked about it all weekend.
 */
export function quoteEntryFees(input: EntryFeeInput): EntryFeeQuote {
  const issues: ValidationIssue[] = [];
  const ends = Math.max(1, input.paying_ends ?? 1);
  const lines: FeeLine[] = [];

  const add = (
    type: string,
    label: string,
    cents: number | undefined,
    destination: string,
    perEnd = true,
  ) => {
    const amount = (cents ?? 0) * (perEnd ? ends : 1);
    if (amount > 0) lines.push({ type, label, amount_cents: amount, destination });
  };

  if (input.entry_fee_cents < 0) {
    issues.push({
      field: 'entry_fee',
      code: 'NEGATIVE_FEE',
      severity: 'error',
      message: 'An entry fee cannot be negative.',
    });
    return { lines: [], total_cents: 0, to_purse_cents: 0, to_sidepots_cents: 0, issues };
  }

  add('entry_fee', 'Entry fee', input.entry_fee_cents, 'purse');
  add('stock_charge', 'Stock charge', input.stock_charge_cents, 'stock_contractor');
  add('office_fee', 'Office fee', input.office_fee_cents, 'producer');
  add('sanctioning_fee', 'Sanctioning fee', input.sanctioning_fee_cents, 'association');

  if (input.is_late) {
    add('late_fee', 'Late entry fee', input.late_fee_cents, 'producer');
    if (!input.late_fee_cents) {
      issues.push({
        field: 'late_fee',
        code: 'LATE_WITHOUT_FEE',
        severity: 'warning',
        message:
          'This entry is after books close but no late fee is configured. ' +
          'It has been taken at the normal price.',
      });
    }
  }

  // Sidepots are a flat buy-in per entry, not per end: a team buys into the
  // incentive once.
  for (const pot of input.sidepots ?? []) {
    if (pot.buy_in_cents > 0) {
      lines.push({
        type: 'sidepot_buyin',
        label: pot.name,
        amount_cents: pot.buy_in_cents,
        destination: `sidepot:${pot.id}`,
      });
    }
  }

  const total = lines.reduce((s, l) => s + l.amount_cents, 0);
  const toPurse = lines
    .filter((l) => l.destination === 'purse')
    .reduce((s, l) => s + l.amount_cents, 0);
  const toSidepots = lines
    .filter((l) => l.destination.startsWith('sidepot:'))
    .reduce((s, l) => s + l.amount_cents, 0);

  return {
    lines,
    total_cents: total,
    to_purse_cents: toPurse,
    to_sidepots_cents: toSidepots,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface EntryEligibilityInput {
  /** Rodeo status: entries only open in 'entries_open'. */
  rodeo_status: string;
  allow_online_entry: boolean;
  /** Set when the producer is entering on the contestant's behalf. */
  entered_by_staff?: boolean;
  books_open_at?: string | null;
  books_close_at?: string | null;
  /** ISO timestamp of the attempt. Passed in — the engine never reads a clock. */
  now: string;
  /** How many live entries this contestant already has in this event. */
  existing_entries: number;
  max_entries_per_contestant: number;
  /** Waivers this event requires that the contestant has not signed. */
  unsigned_waivers?: string[];
  /** Contestant is under 18 and has no guardian consent on file. */
  minor_without_consent?: boolean;
  /** Association membership required and missing or expired. */
  membership_problem?: string | null;
}

export interface EntryEligibility {
  eligible: boolean;
  /** True when the entry is late but still allowed, so a late fee applies. */
  is_late: boolean;
  issues: ValidationIssue[];
}

const OPEN_STATUSES = new Set(['entries_open']);

/**
 * Can this contestant enter, right now?
 *
 * Every failure is reported at once so the entry desk can fix everything in
 * one pass instead of being told one problem at a time with a queue behind.
 *
 * Staff can enter somebody after books close — that is a day-of entry and it
 * is normal. What they cannot do is enter into a rodeo that is not taking
 * entries at all, or skip a waiver.
 */
export function checkEntryEligibility(
  input: EntryEligibilityInput,
): EntryEligibility {
  const issues: ValidationIssue[] = [];
  const now = Date.parse(input.now);
  let isLate = false;

  if (!OPEN_STATUSES.has(input.rodeo_status)) {
    issues.push({
      field: 'rodeo_status',
      code: 'ENTRIES_NOT_OPEN',
      severity: 'error',
      message: `This rodeo is '${input.rodeo_status}' and is not taking entries.`,
    });
  }

  if (!input.entered_by_staff && !input.allow_online_entry) {
    issues.push({
      field: 'allow_online_entry',
      code: 'ONLINE_ENTRY_CLOSED',
      severity: 'error',
      message: 'This rodeo does not take online entries. Contact the secretary.',
    });
  }

  if (input.books_open_at && now < Date.parse(input.books_open_at)) {
    issues.push({
      field: 'books_open_at',
      code: 'BOOKS_NOT_OPEN',
      severity: 'error',
      message: `Books open ${input.books_open_at}.`,
    });
  }

  if (input.books_close_at && now > Date.parse(input.books_close_at)) {
    if (input.entered_by_staff) {
      // A day-of entry taken at the desk. Allowed, and it costs extra.
      isLate = true;
    } else {
      issues.push({
        field: 'books_close_at',
        code: 'BOOKS_CLOSED',
        severity: 'error',
        message: `Books closed ${input.books_close_at}.`,
      });
    }
  }

  if (input.existing_entries >= input.max_entries_per_contestant) {
    issues.push({
      field: 'max_entries_per_contestant',
      code: 'ENTRY_LIMIT_REACHED',
      severity: 'error',
      message:
        `Already entered ${input.existing_entries} time(s); this event allows ` +
        `${input.max_entries_per_contestant}.`,
    });
  }

  for (const waiver of input.unsigned_waivers ?? []) {
    issues.push({
      field: 'waivers',
      code: 'WAIVER_UNSIGNED',
      severity: 'error',
      message: `'${waiver}' must be signed before entering.`,
    });
  }

  if (input.minor_without_consent) {
    issues.push({
      field: 'guardian',
      code: 'MINOR_WITHOUT_CONSENT',
      severity: 'error',
      message: 'A contestant under 18 needs guardian consent on file.',
    });
  }

  if (input.membership_problem) {
    issues.push({
      field: 'membership',
      code: 'MEMBERSHIP_PROBLEM',
      severity: 'error',
      message: input.membership_problem,
    });
  }

  return {
    eligible: !issues.some((i) => i.severity === 'error'),
    is_late: isLate,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Turnouts and releases
// ---------------------------------------------------------------------------

export interface TurnoutInput {
  /** ISO timestamp of the notice. */
  notified_at: string;
  /** ISO timestamp the performance starts. */
  performance_at: string;
  release_type: string;
  /** PRCA requires 30 hours. Producers may set their own. */
  required_notice_hours?: number;
  /** Release reasons that never carry a fine, from reference_options. */
  excused_reasons?: string[];
}

export interface TurnoutResult {
  /** 'turned_out' when it counts against them, 'medical_release' otherwise. */
  status: 'turned_out' | 'medical_release';
  /** True when notice was short enough to carry a fine. */
  fineable: boolean;
  hours_notice: number;
  /** Whether the entry fee comes back. */
  refund_due: boolean;
  issues: ValidationIssue[];
}

const DEFAULT_EXCUSED = ['medical', 'vet_release', 'stock_issue', 'weather'];

/**
 * Classify a turnout.
 *
 * PRCA wants 30 hours' notice before the performance; inside that, a turnout
 * is fineable. A documented medical or veterinary release is excused however
 * late it comes, because the alternative is people competing hurt.
 */
export function classifyTurnout(input: TurnoutInput): TurnoutResult {
  const issues: ValidationIssue[] = [];
  const required = input.required_notice_hours ?? 30;
  const excused = new Set(input.excused_reasons ?? DEFAULT_EXCUSED);

  const hours =
    (Date.parse(input.performance_at) - Date.parse(input.notified_at)) / 3_600_000;

  if (!Number.isFinite(hours)) {
    issues.push({
      field: 'notified_at',
      code: 'BAD_TIMESTAMP',
      severity: 'error',
      message: 'Could not read the notice or performance time.',
    });
    return {
      status: 'turned_out',
      fineable: false,
      hours_notice: 0,
      refund_due: false,
      issues,
    };
  }

  const isExcused = excused.has(input.release_type);
  const inTime = hours >= required;

  if (!isExcused && !inTime) {
    issues.push({
      field: 'notified_at',
      code: 'SHORT_NOTICE',
      severity: 'warning',
      message:
        `${hours.toFixed(1)} hours' notice, ${required} required. ` +
        'This turnout is fineable under the ground rules.',
    });
  }

  return {
    status: isExcused ? 'medical_release' : 'turned_out',
    fineable: !isExcused && !inTime,
    hours_notice: Math.round(hours * 10) / 10,
    // Fees come back on an excused release, or when notice was given in time.
    refund_due: isExcused || inTime,
    issues,
  };
}
