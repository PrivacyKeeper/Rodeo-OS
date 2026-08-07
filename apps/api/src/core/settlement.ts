/**
 * Money actually moving.
 *
 * ---------------------------------------------------------------------------
 * THE ARENA REALITY
 * ---------------------------------------------------------------------------
 * A platform that can only pay by card cannot run a jackpot. At a Saturday
 * roping the secretary pays out of a cash box, or writes checks at the desk,
 * and the winners leave with money in their pocket before anybody's bank has
 * heard about it. At the NFR it goes out by transfer weeks later.
 *
 * So settlement is a STATE MACHINE over the ledger, not a Stripe wrapper. Every
 * payment method — card, ACH, cash, check, account credit — moves a ledger row
 * through the same states and leaves the same audit trail. Stripe is one
 * implementation of "the money left"; a secretary counting twenties is another,
 * and the ledger cannot tell the difference afterwards. That is the point.
 *
 * The ledger row itself is immutable (delta D9). Status lives in
 * `transaction_status_events`, appended one row per transition, so the history
 * of a payment is the history — not a column that was overwritten.
 * ---------------------------------------------------------------------------
 */

import type { Tx } from './database/client.ts';

export type TransactionStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'held'
  | 'released';

/**
 * Which transitions are legal.
 *
 * A completed payment cannot go back to pending — that would let a mistake be
 * hidden rather than corrected. It can be refunded, which is a new fact, not
 * an erasure.
 */
const ALLOWED: Record<TransactionStatus, TransactionStatus[]> = {
  pending: ['completed', 'failed', 'held'],
  held: ['released', 'failed'],
  released: ['completed', 'failed'],
  completed: ['refunded'],
  failed: ['pending'], // a retry
  refunded: [],
};

export function canTransition(
  from: TransactionStatus,
  to: TransactionStatus,
): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export class SettlementError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SettlementError';
    this.code = code;
  }
}

export interface SettleInput {
  org_id: string;
  transaction_id: string;
  to_status: TransactionStatus;
  /** A `payment_method` code from reference_options. */
  payment_method?: string;
  /** Check number, Stripe transfer id, "cash box", whatever proves it moved. */
  reference?: string;
  reason?: string;
  actor_id: string;
}

export interface SettleResult {
  transaction_id: string;
  from_status: TransactionStatus;
  to_status: TransactionStatus;
  amount_cents: number;
  already_in_state: boolean;
}

const toCents = (v: string | number | null) => Math.round(Number(v ?? 0) * 100);

/**
 * Move one ledger row to a new status.
 *
 * Idempotent: settling a row that is already in the target state returns
 * cleanly rather than appending a duplicate event, so a retried request after
 * a timeout does not litter the audit trail.
 *
 * The current status is read from the latest status event with `FOR UPDATE` on
 * the transaction row, so two secretaries clicking "paid" at the same moment
 * serialise instead of both succeeding.
 */
export async function settleTransaction(
  tx: Tx,
  input: SettleInput,
): Promise<SettleResult> {
  // Serialise concurrent settlements of the same payment with an advisory
  // lock rather than `SELECT ... FOR UPDATE`.
  //
  // This is not a style choice. Postgres applies the UPDATE policy to a
  // locking read, and financial_transactions deliberately has no UPDATE policy
  // at all (delta D9 — the ledger is append-only). `FOR UPDATE` therefore
  // matches ZERO rows for every caller, and settlement would report every
  // payment as missing. An advisory lock takes no row privileges and is
  // released when the transaction ends either way.
  await tx`select pg_advisory_xact_lock(hashtextextended(${input.transaction_id}, 0))`;

  const [txn] = await tx<{ id: string; amount: string; status: string }[]>`
    select id, amount, status
      from financial_transactions
     where id = ${input.transaction_id}
       and org_id = ${input.org_id}
  `;

  if (!txn) {
    throw new SettlementError(
      'TRANSACTION_NOT_FOUND',
      'No such transaction in this organization.',
    );
  }

  // The authoritative status is the newest status event; the column on the
  // immutable row is only the value it was created with.
  const [latest] = await tx<{ to_status: string }[]>`
    select to_status
      from transaction_status_events
     where transaction_id = ${input.transaction_id}
     order by created_at desc, id desc
     limit 1
  `;

  const from = (latest?.to_status ?? txn.status) as TransactionStatus;

  if (from === input.to_status) {
    return {
      transaction_id: txn.id,
      from_status: from,
      to_status: input.to_status,
      amount_cents: toCents(txn.amount),
      already_in_state: true,
    };
  }

  if (!canTransition(from, input.to_status)) {
    throw new SettlementError(
      'ILLEGAL_TRANSITION',
      `A ${from} payment cannot become ${input.to_status}.` +
        (from === 'completed'
          ? ' Record a refund or an adjustment instead of reversing it.'
          : ''),
    );
  }

  await tx`
    insert into transaction_status_events
      (org_id, transaction_id, from_status, to_status, reason, actor_id)
    values
      (${input.org_id}, ${input.transaction_id}, ${from}, ${input.to_status},
       ${
         [input.reason, input.payment_method && `via ${input.payment_method}`, input.reference]
           .filter(Boolean)
           .join(' — ') || null
       },
       ${input.actor_id})
  `;

  return {
    transaction_id: txn.id,
    from_status: from,
    to_status: input.to_status,
    amount_cents: toCents(txn.amount),
    already_in_state: false,
  };
}

/**
 * Settle a whole payout batch at once.
 *
 * This is the "paid everybody out of the cash box" button. It runs in one
 * transaction, so either the whole batch is marked paid or none of it is —
 * a half-settled payout is worse than an unsettled one, because nobody can
 * tell afterwards who actually got handed money.
 */
export async function settleBatch(
  tx: Tx,
  input: {
    org_id: string;
    idempotency_key: string;
    to_status: TransactionStatus;
    payment_method: string;
    reference?: string;
    actor_id: string;
  },
): Promise<{ settled: number; skipped: number; total_cents: number }> {
  const rows = await tx<{ id: string }[]>`
    select id
      from financial_transactions
     where org_id = ${input.org_id}
       and idempotency_key like ${input.idempotency_key + ':%'}
     order by created_at, id
  `;

  if (rows.length === 0) {
    throw new SettlementError(
      'BATCH_NOT_FOUND',
      `No payout batch with key '${input.idempotency_key}'.`,
    );
  }

  let settled = 0;
  let skipped = 0;
  let total = 0;

  for (const row of rows) {
    const result = await settleTransaction(tx, {
      org_id: input.org_id,
      transaction_id: row.id,
      to_status: input.to_status,
      payment_method: input.payment_method,
      reference: input.reference,
      reason: 'payout batch settled',
      actor_id: input.actor_id,
    });
    if (result.already_in_state) skipped++;
    else {
      settled++;
      total += result.amount_cents;
    }
  }

  return { settled, skipped, total_cents: total };
}

// ---------------------------------------------------------------------------
// Taking entry money
// ---------------------------------------------------------------------------

export interface RecordPaymentInput {
  org_id: string;
  rodeo_id: string;
  rodeo_event_id?: string;
  entry_id?: string;
  from_user_id: string;
  /** Itemised, from the engine's quoteEntryFees(). */
  lines: { type: string; amount_cents: number; destination: string }[];
  payment_method: string;
  reference?: string;
  /** Set when the money is already in hand — cash and check settle instantly. */
  settled: boolean;
  idempotency_key: string;
  actor_id: string;
}

/** Which ledger type each fee lands under. */
const FEE_LEDGER_TYPE: Record<string, string> = {
  entry_fee: 'entry_fee',
  stock_charge: 'entry_fee',
  office_fee: 'fee_office',
  facility_fee: 'fee_facility',
  sanctioning_fee: 'fee_circuit',
  late_fee: 'fee_office',
  sidepot_buyin: 'entry_fee',
  insurance_fee: 'fee_insurance',
};

/**
 * Write an entry payment to the ledger, itemised.
 *
 * One ledger row per fee line rather than a single lump, because the office
 * fee, the stock charge and the purse contribution go to three different
 * people and the producer's settlement report has to be able to say so.
 *
 * Cash and check arrive already settled — the money is physically in the box —
 * so those rows go straight to `completed`. Card and ACH sit `pending` until
 * the processor confirms.
 */
export async function recordEntryPayment(
  tx: Tx,
  input: RecordPaymentInput,
): Promise<{ transaction_ids: string[]; total_cents: number; already_recorded: boolean }> {
  const existing = await tx<{ id: string }[]>`
    select id from financial_transactions
     where org_id = ${input.org_id}
       and idempotency_key like ${input.idempotency_key + ':%'}
  `;

  if (existing.length > 0) {
    const [agg] = await tx<{ total: string | null }[]>`
      select sum(amount) as total from financial_transactions
       where org_id = ${input.org_id}
         and idempotency_key like ${input.idempotency_key + ':%'}
    `;
    return {
      transaction_ids: existing.map((r) => r.id),
      total_cents: toCents(agg?.total ?? 0),
      already_recorded: true,
    };
  }

  const ids: string[] = [];
  let total = 0;

  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    if (line.amount_cents <= 0) continue;

    const [row] = await tx<{ id: string }[]>`
      insert into financial_transactions (
        org_id, rodeo_id, rodeo_event_id, entry_id, from_user_id,
        transaction_type, amount, status, description,
        idempotency_key, metadata
      ) values (
        ${input.org_id}, ${input.rodeo_id}, ${input.rodeo_event_id ?? null},
        ${input.entry_id ?? null}, ${input.from_user_id},
        ${FEE_LEDGER_TYPE[line.type] ?? 'entry_fee'},
        ${(line.amount_cents / 100).toFixed(2)},
        ${input.settled ? 'completed' : 'pending'},
        ${line.type},
        ${`${input.idempotency_key}:${line.type}:${i}`},
        ${tx.json({
          destination: line.destination,
          payment_method: input.payment_method,
          reference: input.reference ?? null,
          taken_by: input.actor_id,
        })}
      )
      returning id
    `;

    await tx`
      insert into transaction_status_events
        (org_id, transaction_id, from_status, to_status, reason, actor_id)
      values
        (${input.org_id}, ${row.id}, null,
         ${input.settled ? 'completed' : 'pending'},
         ${`entry payment via ${input.payment_method}`}, ${input.actor_id})
    `;

    ids.push(row.id);
    total += line.amount_cents;
  }

  return { transaction_ids: ids, total_cents: total, already_recorded: false };
}

/**
 * Refund an entry — a scratch in time, or a cancelled event.
 *
 * The original rows are never touched. A refund is new `refund` rows plus a
 * status event on each original, which is what an auditor needs to see: the
 * money came in, and then it went back.
 */
export async function refundEntry(
  tx: Tx,
  input: {
    org_id: string;
    entry_id: string;
    reason: string;
    actor_id: string;
    /** Leave unset to refund everything taken for this entry. */
    only_types?: string[];
  },
): Promise<{ refunded_cents: number; rows: number }> {
  const rows = await tx<
    { id: string; amount: string; from_user_id: string | null; rodeo_id: string | null; description: string | null }[]
  >`
    select id, amount, from_user_id, rodeo_id, description
      from financial_transactions
     where org_id = ${input.org_id}
       and entry_id = ${input.entry_id}
       and transaction_type in ('entry_fee', 'fee_office', 'fee_facility',
                                'fee_circuit', 'fee_insurance')
     order by created_at
  `;

  let refunded = 0;
  let count = 0;

  for (const row of rows) {
    if (input.only_types && !input.only_types.includes(row.description ?? '')) {
      continue;
    }

    const cents = toCents(row.amount);
    if (cents <= 0) continue;

    await tx`
      insert into financial_transactions (
        org_id, rodeo_id, entry_id, to_user_id, transaction_type, amount,
        status, description, idempotency_key, metadata
      ) values (
        ${input.org_id}, ${row.rodeo_id}, ${input.entry_id}, ${row.from_user_id},
        'refund', ${row.amount}, 'completed',
        ${`Refund: ${input.reason}`},
        ${`refund:${row.id}`},
        ${tx.json({ refund_of: row.id, reason: input.reason, actor: input.actor_id })}
      )
    `;

    await tx`
      insert into transaction_status_events
        (org_id, transaction_id, from_status, to_status, reason, actor_id)
      values
        (${input.org_id}, ${row.id}, 'completed', 'refunded', ${input.reason},
         ${input.actor_id})
    `;

    refunded += cents;
    count++;
  }

  return { refunded_cents: refunded, rows: count };
}
