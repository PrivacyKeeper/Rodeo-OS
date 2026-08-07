/**
 * Entry and draw persistence.
 *
 * Same rules as the other repositories: the transaction already carries the
 * caller's identity, so RLS decides what is visible, and every interpolation
 * is a bound parameter.
 */

import type { Json, Tx } from './client.ts';
import type { DrawAssignment, StockAssignment } from '@rodeo-os/engine';

// ---------------------------------------------------------------------------
// Context for taking an entry
// ---------------------------------------------------------------------------

export interface EntryContext {
  rodeo_id: string;
  rodeo_status: string;
  allow_online_entry: boolean;
  books_open_at: string | null;
  books_close_at: string | null;
  entry_fee_cents: number;
  stock_charge_cents: number;
  max_entries_per_contestant: number;
  event_type: string;
  division_config: unknown | null;
  /** Live entries this contestant already holds in this event. */
  existing_entries: number;
  sidepots: { id: string; name: string; buy_in_cents: number }[];
}

const cents = (v: string | number | null) => Math.round(Number(v ?? 0) * 100);

export async function loadEntryContext(
  tx: Tx,
  orgId: string,
  eventId: string,
  contestantId: string,
): Promise<EntryContext | null> {
  const [row] = await tx<
    {
      rodeo_id: string;
      rodeo_status: string;
      allow_online_entry: boolean;
      books_open_at: string | null;
      books_close_at: string | null;
      entry_fee: string;
      stock_charge: string;
      max_entries_per_contestant: number;
      event_type: string;
      division_config: unknown | null;
    }[]
  >`
    select e.rodeo_id, r.status as rodeo_status, r.allow_online_entry,
           e.books_open_at, e.books_close_at, e.entry_fee, e.stock_charge,
           e.max_entries_per_contestant, e.event_type, e.division_config
      from rodeo_events e
      join rodeos r on r.id = e.rodeo_id
     where e.id = ${eventId} and e.org_id = ${orgId}
  `;
  if (!row) return null;

  const [count] = await tx<{ n: string }[]>`
    select count(*) as n from entries
     where rodeo_event_id = ${eventId}
       and org_id = ${orgId}
       and (contestant_id = ${contestantId} or partner_id = ${contestantId})
       and status not in ('scratched', 'turned_out')
  `;

  const pots = await tx<{ id: string; name: string; buy_in_cents: number }[]>`
    select id, name, buy_in_cents
      from sidepots
     where rodeo_event_id = ${eventId}
       and org_id = ${orgId}
       and status = 'open'
     order by sort_order, name
  `;

  return {
    rodeo_id: row.rodeo_id,
    rodeo_status: row.rodeo_status,
    allow_online_entry: row.allow_online_entry,
    books_open_at: row.books_open_at,
    books_close_at: row.books_close_at,
    entry_fee_cents: cents(row.entry_fee),
    stock_charge_cents: cents(row.stock_charge),
    max_entries_per_contestant: row.max_entries_per_contestant,
    event_type: row.event_type,
    division_config: row.division_config,
    existing_entries: Number(count?.n ?? 0),
    sidepots: pots.map((p) => ({
      id: p.id,
      name: p.name,
      buy_in_cents: Number(p.buy_in_cents),
    })),
  };
}

export interface CreateEntryInput {
  id: string;
  org_id: string;
  rodeo_id: string;
  rodeo_event_id: string;
  contestant_id: string;
  partner_id?: string | null;
  entry_slot: number;
  entry_fee_cents: number;
  division_name?: string | null;
  header_number?: number | null;
  heeler_number?: number | null;
  buddy_group_id?: string | null;
  sidepot_ids?: string[];
}

/**
 * Create the entry and any sidepot buy-ins in one transaction.
 *
 * The unique index on (rodeo_event_id, contestant_id, entry_slot,
 * go_round_number) is what stops a double-submit becoming two entries — the
 * second insert conflicts rather than quietly creating a duplicate run.
 */
export async function createEntry(
  tx: Tx,
  input: CreateEntryInput,
): Promise<{ id: string; sidepots: number }> {
  await tx`
    insert into entries (
      id, org_id, rodeo_id, rodeo_event_id, contestant_id, partner_id,
      entry_slot, entry_fee_amount, division_name, header_number, heeler_number,
      buddy_group_id, status
    ) values (
      ${input.id}, ${input.org_id}, ${input.rodeo_id}, ${input.rodeo_event_id},
      ${input.contestant_id}, ${input.partner_id ?? null}, ${input.entry_slot},
      ${(input.entry_fee_cents / 100).toFixed(2)},
      ${input.division_name ?? null}, ${input.header_number ?? null},
      ${input.heeler_number ?? null}, ${input.buddy_group_id ?? null},
      'pending'
    )
  `;

  let potCount = 0;
  for (const sidepotId of input.sidepot_ids ?? []) {
    const [pot] = await tx<{ buy_in_cents: number }[]>`
      select buy_in_cents from sidepots
       where id = ${sidepotId} and org_id = ${input.org_id} and status = 'open'
    `;
    if (!pot) continue;
    await tx`
      insert into sidepot_entries
        (org_id, sidepot_id, entry_id, contestant_id, amount_paid_cents)
      values
        (${input.org_id}, ${sidepotId}, ${input.id}, ${input.contestant_id},
         ${pot.buy_in_cents})
    `;
    potCount++;
  }

  return { id: input.id, sidepots: potCount };
}

/** Mark an entry paid and confirmed once the money is recorded. */
export async function confirmEntry(
  tx: Tx,
  orgId: string,
  entryId: string,
): Promise<boolean> {
  const rows = await tx`
    update entries
       set status = 'confirmed', fees_paid = true, confirmed_at = now()
     where id = ${entryId} and org_id = ${orgId} and status = 'pending'
    returning id
  `;
  return rows.length > 0;
}

export async function scratchEntry(
  tx: Tx,
  input: {
    org_id: string;
    entry_id: string;
    status: 'scratched' | 'turned_out' | 'medical_release';
    release_type?: string;
    notified_at?: string;
  },
): Promise<boolean> {
  const rows = await tx`
    update entries
       set status = ${input.status},
           release_type = ${input.release_type ?? null},
           turnout_notified_at = ${input.notified_at ?? null}
     where id = ${input.entry_id}
       and org_id = ${input.org_id}
       and status in ('pending', 'confirmed', 'drawn')
    returning id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

export interface DrawableEntryRow {
  entry_id: string;
  contestant_id: string;
  buddy_group_id: string | null;
  division: string | null;
  entered_seq: number;
  slot: number;
}

export async function loadDrawableEntries(
  tx: Tx,
  orgId: string,
  eventId: string,
): Promise<DrawableEntryRow[]> {
  return tx<DrawableEntryRow[]>`
    select id as entry_id, contestant_id, buddy_group_id,
           division_name as division,
           row_number() over (order by entered_at, id)::int as entered_seq,
           entry_slot as slot
      from entries
     where rodeo_event_id = ${eventId}
       and org_id = ${orgId}
       and status in ('confirmed', 'drawn')
     order by entered_at, id
  `;
}

export async function loadPerformanceSlots(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<
  { performance_number: number; performance_type: string; capacity: number | null }[]
> {
  return tx`
    select performance_number, performance_type,
           null::int as capacity
      from performances
     where rodeo_id = ${rodeoId}
       and org_id = ${orgId}
       and status <> 'cancelled'
     order by performance_number
  `;
}

/**
 * Write a draw.
 *
 * The seed is stored on every entry's audit trail via the draw metadata so the
 * draw can be replayed and checked later. Recording the result without the
 * seed would make "it was a random draw" unfalsifiable.
 */
export async function saveDraw(
  tx: Tx,
  input: {
    org_id: string;
    rodeo_event_id: string;
    seed: string;
    method: string;
    assignments: DrawAssignment[];
    actor_id: string;
  },
): Promise<number> {
  for (const a of input.assignments) {
    await tx`
      update entries
         set performance_number = ${a.performance_number},
             draw_position = ${a.draw_position},
             go_round_number = ${a.go_round},
             status = 'drawn',
             drawn_at = now()
       where id = ${a.entry_id}
         and org_id = ${input.org_id}
    `;
  }

  await tx`
    insert into audit_log (org_id, actor_id, action, entity_type, entity_id, after)
    values (${input.org_id}, ${input.actor_id}, 'draw.generated', 'rodeo_event',
            ${input.rodeo_event_id},
            ${tx.json({
              seed: input.seed,
              method: input.method,
              entries: input.assignments.length,
            } as Json)})
  `;

  return input.assignments.length;
}

export async function loadDrawableAnimals(
  tx: Tx,
  orgId: string,
  animalType: string,
): Promise<{ animal_id: string; health_status: string; contractor_id: string | null }[]> {
  return tx`
    select id as animal_id, health_status, contractor_id
      from animals
     where org_id = ${orgId}
       and animal_type = ${animalType}
     order by id
  `;
}

export async function saveStockDraw(
  tx: Tx,
  input: {
    org_id: string;
    rodeo_id: string;
    rodeo_event_id: string;
    assignments: StockAssignment[];
  },
): Promise<number> {
  for (const a of input.assignments) {
    await tx`
      insert into stock_draws (
        org_id, rodeo_id, rodeo_event_id, entry_id, animal_id,
        go_round, performance
      ) values (
        ${input.org_id}, ${input.rodeo_id}, ${input.rodeo_event_id},
        ${a.entry_id}, ${a.animal_id}, ${a.go_round}, ${a.performance_number}
      )
      on conflict do nothing
    `;
  }
  return input.assignments.length;
}

/** Animals already drawn in this go-round, so a re-draw cannot double-book. */
export async function loadDrawnAnimals(
  tx: Tx,
  orgId: string,
  eventId: string,
  goRound: number,
): Promise<string[]> {
  const rows = await tx<{ animal_id: string }[]>`
    select animal_id from stock_draws
     where org_id = ${orgId} and rodeo_event_id = ${eventId} and go_round = ${goRound}
  `;
  return rows.map((r) => r.animal_id);
}

export async function recordRedraw(
  tx: Tx,
  input: {
    org_id: string;
    rodeo_id: string;
    rodeo_event_id: string;
    entry_id: string;
    original_draw_id: string;
    animal_id: string;
    reason: string;
    go_round: number;
  },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into stock_draws (
      org_id, rodeo_id, rodeo_event_id, entry_id, animal_id, go_round,
      is_redraw, original_draw_id, redraw_reason
    ) values (
      ${input.org_id}, ${input.rodeo_id}, ${input.rodeo_event_id},
      ${input.entry_id}, ${input.animal_id}, ${input.go_round},
      true, ${input.original_draw_id}, ${input.reason}
    )
    returning id
  `;
  return row.id;
}
