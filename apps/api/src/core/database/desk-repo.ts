/**
 * The entry desk — people, entries, back numbers and sidepots.
 *
 * ---------------------------------------------------------------------------
 * This is the only part of the system with a queue of humans standing in front
 * of it. Everything here is optimised for a secretary typing three letters of
 * a surname while somebody waits, not for elegance.
 * ---------------------------------------------------------------------------
 *
 * Same rules as the other repositories: RLS does the isolation, every value is
 * bound by a tagged template, JSONB goes in via `tx.json()`.
 */

import type { Json, Tx } from './client.ts';

// ===========================================================================
// People
// ===========================================================================

export interface PersonRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state_province: string | null;
  memberships: unknown;
  /** True when this person has ever entered anything at this organisation. */
  known_here: boolean;
  entries_here: number;
}

/**
 * Find a person.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SEARCHES EVERY PERSON AND NOT JUST THIS ORG'S
 * ---------------------------------------------------------------------------
 * `users` is global by design — a contestant competes under many producers and
 * exists once. If the desk could only search its own org, every producer would
 * re-create the same roper, the career record would fragment across duplicates,
 * and the whole point of the record layer would be lost at the exact moment it
 * is created.
 *
 * So the search is global and the RESULT is narrow: name, city, state, and
 * whether they have entered here before. No email, no phone, no address, no
 * date of birth, no tax fields. Enough to say "yes, that's the Casey Roper
 * from Ada" and nothing a stranger could use.
 *
 * Contact details come back only for somebody already entered at this
 * organisation — see loadPerson().
 */
export async function searchPeople(
  tx: Tx,
  orgId: string,
  query: string,
  limit = 20,
): Promise<PersonRow[]> {
  // Goes through search_people() rather than querying `users` directly. A
  // direct query returns only people this org already has a relationship with,
  // which makes the anti-duplicate search impossible — see delta D37. The
  // function is SECURITY DEFINER with a narrow projection and it checks that
  // the caller is staff of p_org_id before it returns anything.
  return tx<PersonRow[]>`
    select id, first_name, last_name, email, phone, city, state_province,
           memberships, known_here, entries_here
      from search_people(${orgId}, ${query}, ${limit})
  `;
}

export async function loadPerson(
  tx: Tx,
  orgId: string,
  personId: string,
): Promise<PersonRow | null> {
  const [row] = await tx<PersonRow[]>`
    select
      u.id, u.first_name, u.last_name,
      case when k.entries > 0 then u.email::text else null end as email,
      case when k.entries > 0 then u.phone else null end       as phone,
      u.city, u.state_province, u.memberships,
      (k.entries > 0) as known_here,
      k.entries::int  as entries_here
    from users u
    cross join lateral (
      select count(*) as entries
        from entries e
       where e.contestant_id = u.id and e.org_id = ${orgId}
    ) k
    where u.id = ${personId}
  `;
  return row ?? null;
}

export interface NewPerson {
  first_name: string;
  last_name: string;
  email?: string | null;
  phone?: string | null;
  date_of_birth?: string | null;
  city?: string | null;
  state_province?: string | null;
  memberships?: unknown;
}

/**
 * Create a contestant record for somebody who has never signed in.
 *
 * `supabase_auth_id` stays null: a secretary types a name at the desk and that
 * person may never open an app. They can claim the record later and everything
 * they have won is already attached to it.
 */
export async function createPerson(tx: Tx, input: NewPerson): Promise<PersonRow> {
  const [row] = await tx<PersonRow[]>`
    insert into users (first_name, last_name, email, phone, date_of_birth,
                       city, state_province, memberships)
    values (${input.first_name}, ${input.last_name},
            ${input.email ?? null}, ${input.phone ?? null},
            ${input.date_of_birth ?? null},
            ${input.city ?? null}, ${input.state_province ?? null},
            ${tx.json((input.memberships ?? []) as Json)})
    returning id, first_name, last_name, email::text as email, phone,
              city, state_province, memberships,
              false as known_here, 0 as entries_here
  `;
  return row;
}

/**
 * Fold one duplicate person into another.
 *
 * The desk creates duplicates — "Casey Roper", "Casey  Roper", "C Roper" — and
 * every duplicate splits somebody's career record in half. This moves the
 * dependent rows and writes an immutable `person_merges` row saying what was
 * done and why.
 *
 * The merged record is NOT deleted. It stays as a tombstone so a later
 * question about where a run went has an answer.
 */
export async function mergePeople(
  tx: Tx,
  keepId: string,
  mergeId: string,
  actorId: string | null,
  reason: string,
): Promise<{ moved: Record<string, number> }> {
  if (keepId === mergeId) throw new Error('cannot merge a person into themselves');

  const [snapshot] = await tx<{ row: unknown }[]>`
    select to_jsonb(u) as row from users u where u.id = ${mergeId}
  `;
  if (!snapshot) throw new Error('person not found');

  const moved: Record<string, number> = {};

  /**
   * Entries move one at a time, and the reason is a constraint the first
   * version of this function walked straight into.
   *
   * `idx_entries_unique` allows one live entry per (event, contestant, slot,
   * round). Both duplicates are usually entered in the SAME event — that is
   * how the duplicate got noticed — so a blanket UPDATE makes two rows with
   * the same key and the merge fails with a unique violation.
   *
   * `entry_slot` exists for exactly this: delta D10 added it because ropers
   * legitimately enter one event more than once. A person who was accidentally
   * entered twice under two records genuinely has two entries, so the second
   * one takes the next free slot rather than being rejected or discarded.
   */
  const theirEntries = await tx<
    { id: string; rodeo_event_id: string; go_round_number: number }[]
  >`
    select id, rodeo_event_id, go_round_number
      from entries where contestant_id = ${mergeId}
      order by entered_at
  `;
  let entriesMoved = 0;
  for (const entry of theirEntries) {
    const [{ next_slot: nextSlot }] = await tx<{ next_slot: number }[]>`
      select coalesce(max(entry_slot), 0) + 1 as next_slot
        from entries
       where rodeo_event_id = ${entry.rodeo_event_id}
         and contestant_id = ${keepId}
         and go_round_number = ${entry.go_round_number}
    `;
    await tx`
      update entries
         set contestant_id = ${keepId}, entry_slot = ${nextSlot}, updated_at = now()
       where id = ${entry.id}
    `;
    entriesMoved += 1;
  }
  moved.entries = entriesMoved;

  // A team-roping entry naming the duplicate as partner becomes an entry whose
  // partner is its own contestant, which `partner_is_not_self` rejects. Null
  // the partner rather than fail: the run happened, and a secretary can name
  // the right partner afterwards.
  const selfPartner = await tx`
    update entries set partner_id = null, updated_at = now()
     where partner_id = ${mergeId} and contestant_id = ${keepId}
  `;
  moved.partner_cleared = selfPartner.count;

  const p = await tx`
    update entries set partner_id = ${keepId}, updated_at = now()
     where partner_id = ${mergeId}
  `;
  moved.partner_entries = p.count;

  const s = await tx`update scores set contestant_id = ${keepId} where contestant_id = ${mergeId}`;
  moved.scores = s.count;

  /**
   * Results are DERIVED, and their unique index has the same collision
   * problem. Rather than invent a rule for merging two placings, the merged
   * record's rows are dropped where they would collide and moved where they
   * would not — then the event is re-finalised and every placing is recomputed
   * from the scores, which have all moved correctly.
   */
  const droppedResults = await tx`
    delete from results r
     where r.contestant_id = ${mergeId}
       and exists (
         select 1 from results k
          where k.rodeo_event_id = r.rodeo_event_id
            and k.contestant_id = ${keepId}
            and k.result_type = r.result_type
            and k.go_round is not distinct from r.go_round
            and k.d_division is not distinct from r.d_division
       )
  `;
  moved.results_superseded = droppedResults.count;

  const r = await tx`update results set contestant_id = ${keepId} where contestant_id = ${mergeId}`;
  moved.results = r.count;

  // Career runs have the same shape of index, and the same answer: a platform
  // run is rewritten from official results, so a collision is dropped.
  const droppedRuns = await tx`
    delete from career_runs c
     where c.contestant_id = ${mergeId}
       and c.source = 'platform'
       and exists (
         select 1 from career_runs k
          where k.contestant_id = ${keepId}
            and k.source = 'platform'
            and k.rodeo_event_id is not distinct from c.rodeo_event_id
            and k.result_type = c.result_type
            and k.go_round is not distinct from c.go_round
            and k.d_division is not distinct from c.d_division
       )
  `;
  moved.career_runs_superseded = droppedRuns.count;

  const c = await tx`update career_runs set contestant_id = ${keepId} where contestant_id = ${mergeId}`;
  moved.career_runs = c.count;

  // Back numbers: one per person per rodeo, so the duplicate's number is
  // released if the kept record already has one at that rodeo.
  await tx`
    delete from back_numbers b
     where b.contestant_id = ${mergeId}
       and exists (
         select 1 from back_numbers k
          where k.rodeo_id = b.rodeo_id and k.contestant_id = ${keepId}
       )
  `;
  const bn = await tx`
    update back_numbers set contestant_id = ${keepId}, updated_at = now()
     where contestant_id = ${mergeId}
  `;
  moved.back_numbers = bn.count;

  await tx`
    insert into person_merges (kept_user_id, merged_user_id, merged_by, reason, snapshot)
    values (${keepId}, ${mergeId}, ${actorId}, ${reason},
            ${tx.json(snapshot.row as Json)})
  `;

  return { moved };
}

// ===========================================================================
// Entries at a glance
// ===========================================================================

export interface EntryListRow {
  entry_id: string;
  rodeo_event_id: string;
  event_label: string;
  contestant_id: string;
  contestant_name: string;
  partner_name: string | null;
  horse_name: string | null;
  back_number: string | null;
  go_round: number;
  entry_slot: number;
  draw_position: number | null;
  performance_number: number | null;
  status: string;
  entry_fee_amount: string | null;
  fees_paid: boolean;
  score_status: string | null;
  notes: string | null;
}

export async function listEntries(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  eventId: string | null,
): Promise<EntryListRow[]> {
  return tx<EntryListRow[]>`
    select
      en.id as entry_id,
      en.rodeo_event_id,
      coalesce(o.label, replace(ev.event_type, '_', ' ')) as event_label,
      en.contestant_id,
      trim(u.first_name || ' ' || u.last_name) as contestant_name,
      case when p.id is null then null
           else trim(p.first_name || ' ' || p.last_name) end as partner_name,
      h.barn_name as horse_name,
      b.back_number,
      en.go_round_number as go_round,
      en.entry_slot,
      en.draw_position,
      en.performance_number,
      en.status,
      en.entry_fee_amount::text as entry_fee_amount,
      en.fees_paid,
      (select s.status from scores s
        where s.entry_id = en.id and s.go_round = en.go_round_number
        order by case s.status when 'official' then 0 else 1 end
        limit 1) as score_status,
      en.notes
    from entries en
    join rodeo_events ev on ev.id = en.rodeo_event_id
    join users u on u.id = en.contestant_id
    left join users p on p.id = en.partner_id
    left join animal_registry h on h.id = en.horse_id
    left join back_numbers b
           on b.rodeo_id = en.rodeo_id and b.contestant_id = en.contestant_id
    left join reference_options o
           on o.domain = 'event_type' and o.code = ev.event_type
          and (o.org_id = ${orgId} or o.org_id is null)
   where en.org_id = ${orgId} and en.rodeo_id = ${rodeoId}
     and (${eventId}::uuid is null or en.rodeo_event_id = ${eventId})
   order by ev.sort_order, en.go_round_number,
            en.draw_position nulls last, u.last_name, u.first_name
  `;
}

/** Set the note on an entry. The one field a secretary edits constantly. */
export async function setEntryNote(
  tx: Tx,
  orgId: string,
  entryId: string,
  note: string | null,
): Promise<boolean> {
  const rows = await tx`
    update entries set notes = ${note}, updated_at = now()
     where id = ${entryId} and org_id = ${orgId}
  `;
  return rows.count > 0;
}

/** Mark an entry's fee as taken at the desk. */
export async function markEntryPaid(
  tx: Tx,
  orgId: string,
  entryId: string,
  paid: boolean,
): Promise<boolean> {
  const rows = await tx`
    update entries set fees_paid = ${paid}, updated_at = now()
     where id = ${entryId} and org_id = ${orgId}
  `;
  return rows.count > 0;
}

// ===========================================================================
// Back numbers
// ===========================================================================

export interface BackNumberRow {
  contestant_id: string;
  contestant_name: string;
  back_number: string;
  issued_at: string;
  returned_at: string | null;
}

export async function listBackNumbers(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<BackNumberRow[]> {
  return tx<BackNumberRow[]>`
    select b.contestant_id,
           trim(u.first_name || ' ' || u.last_name) as contestant_name,
           b.back_number,
           b.issued_at::text as issued_at,
           b.returned_at::text as returned_at
      from back_numbers b
      join users u on u.id = b.contestant_id
     where b.org_id = ${orgId} and b.rodeo_id = ${rodeoId}
     -- Numeric numbers sort numerically; '7A' and '2-B' fall back to text.
     order by case when b.back_number ~ '^[0-9]+$'
                   then lpad(b.back_number, 8, '0') else b.back_number end
  `;
}

export async function setBackNumber(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  contestantId: string,
  backNumber: string,
): Promise<BackNumberRow> {
  const [row] = await tx<{ contestant_id: string; back_number: string }[]>`
    insert into back_numbers (org_id, rodeo_id, contestant_id, back_number)
    values (${orgId}, ${rodeoId}, ${contestantId}, ${backNumber})
    on conflict (rodeo_id, contestant_id)
      do update set back_number = excluded.back_number, updated_at = now()
    returning contestant_id, back_number
  `;
  const [named] = await tx<BackNumberRow[]>`
    select b.contestant_id,
           trim(u.first_name || ' ' || u.last_name) as contestant_name,
           b.back_number, b.issued_at::text as issued_at,
           b.returned_at::text as returned_at
      from back_numbers b join users u on u.id = b.contestant_id
     where b.rodeo_id = ${rodeoId} and b.contestant_id = ${row.contestant_id}
  `;
  return named;
}

export async function assignBackNumbers(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  start = 1,
): Promise<number> {
  const [row] = await tx<{ assign_back_numbers: number }[]>`
    select assign_back_numbers(${orgId}, ${rodeoId}, ${start})
  `;
  return row?.assign_back_numbers ?? 0;
}

// ===========================================================================
// Sidepots
// ===========================================================================

export interface SidepotRow {
  id: string;
  rodeo_event_id: string;
  event_label: string;
  name: string;
  sidepot_type: string;
  buy_in_cents: number;
  added_money_cents: number;
  go_round: number | null;
  status: string;
  payout_config_id: string | null;
  buyers: number;
  collected_cents: string;
}

export async function listSidepots(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<SidepotRow[]> {
  return tx<SidepotRow[]>`
    select sp.id, sp.rodeo_event_id,
           coalesce(o.label, replace(ev.event_type, '_', ' ')) as event_label,
           sp.name, sp.sidepot_type, sp.buy_in_cents, sp.added_money_cents,
           sp.go_round, sp.status, sp.payout_config_id,
           coalesce(b.buyers, 0)::int as buyers,
           coalesce(b.collected, 0)::text as collected_cents
      from sidepots sp
      join rodeo_events ev on ev.id = sp.rodeo_event_id
      left join reference_options o
             on o.domain = 'event_type' and o.code = ev.event_type
            and (o.org_id = ${orgId} or o.org_id is null)
      left join lateral (
        select count(*) as buyers,
               sum(se.amount_paid_cents) filter (where se.paid) as collected
          from sidepot_entries se where se.sidepot_id = sp.id
      ) b on true
     where sp.org_id = ${orgId} and sp.rodeo_id = ${rodeoId}
     order by ev.sort_order, sp.sort_order, sp.name
  `;
}

export interface NewSidepot {
  rodeo_event_id: string;
  name: string;
  sidepot_type?: string;
  buy_in_cents: number;
  added_money_cents?: number;
  go_round?: number | null;
  payout_config_id?: string | null;
  eligibility?: unknown;
}

export async function createSidepot(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  input: NewSidepot,
): Promise<{ id: string; name: string }> {
  const [row] = await tx<{ id: string; name: string }[]>`
    insert into sidepots (org_id, rodeo_id, rodeo_event_id, name, sidepot_type,
                          buy_in_cents, added_money_cents, go_round,
                          payout_config_id, eligibility)
    values (${orgId}, ${rodeoId}, ${input.rodeo_event_id}, ${input.name},
            ${input.sidepot_type ?? 'sidepot'}, ${input.buy_in_cents},
            ${input.added_money_cents ?? 0}, ${input.go_round ?? null},
            ${input.payout_config_id ?? null},
            ${input.eligibility ? tx.json(input.eligibility as Json) : null})
    returning id, name
  `;
  return row;
}

export async function setSidepotStatus(
  tx: Tx,
  orgId: string,
  sidepotId: string,
  status: string,
): Promise<boolean> {
  const rows = await tx`
    update sidepots set status = ${status}, updated_at = now()
     where id = ${sidepotId} and org_id = ${orgId}
  `;
  return rows.count > 0;
}

export interface SidepotStanding {
  contestant_id: string;
  contestant_name: string;
  entry_id: string;
  paid: boolean;
  final_time: string | null;
  final_score: string | null;
  score_status: string | null;
}

/**
 * Who is in a sidepot and how they ran.
 *
 * Only PAID buy-ins are scored. A contestant who said they wanted in and never
 * handed over the money is not in the pot, and the pot has to reconcile
 * against what was actually collected.
 */
export async function loadSidepotStandings(
  tx: Tx,
  orgId: string,
  sidepotId: string,
): Promise<{
  sidepot: {
    id: string;
    name: string;
    rodeo_event_id: string;
    buy_in_cents: number;
    added_money_cents: number;
    go_round: number | null;
    payout_config_id: string | null;
    scoring_mode: string;
    status: string;
  } | null;
  standings: SidepotStanding[];
}> {
  const [sidepot] = await tx<
    {
      id: string;
      name: string;
      rodeo_event_id: string;
      buy_in_cents: number;
      added_money_cents: number;
      go_round: number | null;
      payout_config_id: string | null;
      scoring_mode: string;
      status: string;
    }[]
  >`
    select sp.id, sp.name, sp.rodeo_event_id, sp.buy_in_cents,
           sp.added_money_cents, sp.go_round, sp.payout_config_id,
           ev.scoring_mode, sp.status
      from sidepots sp
      join rodeo_events ev on ev.id = sp.rodeo_event_id
     where sp.id = ${sidepotId} and sp.org_id = ${orgId}
  `;
  if (!sidepot) return { sidepot: null, standings: [] };

  const standings = await tx<SidepotStanding[]>`
    select se.contestant_id,
           trim(u.first_name || ' ' || u.last_name) as contestant_name,
           se.entry_id, se.paid,
           s.final_time::text as final_time,
           s.final_score::text as final_score,
           s.status as score_status
      from sidepot_entries se
      join users u on u.id = se.contestant_id
      left join scores s
             on s.entry_id = se.entry_id
            and (${sidepot.go_round}::int is null or s.go_round = ${sidepot.go_round})
            and s.status in ('official', 'provisional')
     where se.sidepot_id = ${sidepotId} and se.org_id = ${orgId}
     order by u.last_name, u.first_name
  `;

  return { sidepot, standings };
}

/**
 * The payout ladder a sidepot uses.
 *
 * Falls back to the parent event's ladder when the sidepot has none of its
 * own, which is the common case: a producer adds a $20 sidepot and expects it
 * to pay the same way the event does.
 */
export async function loadSidepotPayoutConfig(
  tx: Tx,
  orgId: string,
  sidepotId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await tx<{ config: Record<string, unknown> }[]>`
    select coalesce(spc.config, evc.config) as config
      from sidepots sp
      join rodeo_events ev on ev.id = sp.rodeo_event_id
      left join payout_configs spc on spc.id = sp.payout_config_id
      left join payout_configs evc on evc.id = ev.payout_config_id
     where sp.id = ${sidepotId} and sp.org_id = ${orgId}
  `;
  return row?.config ?? null;
}
