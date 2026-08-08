/**
 * Operations repository — day sheets, the books, associations, compliance and
 * the global record.
 *
 * Same rules as repositories.ts: every function runs inside a transaction that
 * already carries the caller's verified identity, RLS does the isolation, and
 * every value is bound by a tagged template rather than concatenated.
 *
 * JSONB goes in via `tx.json(value)`. Never `JSON.stringify(v)::jsonb` — that
 * binds TEXT and stores a jsonb string scalar. See docs/SPEC-DELTAS.md D26.
 */

import type {
  BooksEntryRow,
  BooksEventRow,
  BooksComplianceRow,
  DaySheetEntry,
  DaySheetEvent,
  DaySheetPersonnel,
  DaySheetStock,
  FilingRule,
  AssociationFeeSchedule,
} from '@rodeo-os/engine';

import type { Json, Tx } from './client.ts';

/** Decimal dollars from the database to integer cents for the engine. */
function cents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100);
}

// ===========================================================================
// Day sheets
// ===========================================================================

export interface DaySheetContext {
  rodeo: {
    id: string;
    name: string;
    venue: string | null;
    timezone: string;
    start_date: string;
    end_date: string;
  };
  performance: {
    number: number | null;
    name: string;
    type: 'performance' | 'slack' | 'short_go' | 'finals';
    date: string;
    scheduled_start: string | null;
    arena_dragged_after: number | null;
    condensed_drag: boolean;
  };
  sanctioned_by: string[];
  events: DaySheetEvent[];
  entries: DaySheetEntry[];
  stock: DaySheetStock[];
  personnel: DaySheetPersonnel[];
}

export async function loadDaySheet(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  performanceNumber: number | null,
): Promise<DaySheetContext | null> {
  const [rodeo] = await tx<
    {
      id: string;
      name: string;
      venue_name: string | null;
      venue_city: string | null;
      venue_state: string | null;
      timezone: string;
      start_date: string;
      end_date: string;
    }[]
  >`
    select id, name, venue_name, venue_city, venue_state, timezone,
           start_date::text as start_date, end_date::text as end_date
      from rodeos
     where id = ${rodeoId} and org_id = ${orgId}
  `;
  if (!rodeo) return null;

  const perfRows = performanceNumber === null
    ? []
    : await tx<
        {
          performance_number: number;
          name: string | null;
          performance_type: 'performance' | 'slack' | 'short_go' | 'finals';
          scheduled_start: string | null;
          arena_dragged_after: number | null;
          condensed_drag: boolean;
        }[]
      >`
        select performance_number, name, performance_type,
               scheduled_start::text as scheduled_start,
               arena_dragged_after, condensed_drag
          from performances
         where org_id = ${orgId} and rodeo_id = ${rodeoId}
           and performance_number = ${performanceNumber}
      `;
  const perf = perfRows[0];

  const eventRows = await tx<
    {
      id: string;
      event_type: string;
      scoring_mode: 'judged' | 'timed';
      is_roughstock: boolean;
      sort_order: number;
      label: string | null;
    }[]
  >`
    select e.id, e.event_type, e.scoring_mode, e.is_roughstock, e.sort_order,
           o.label
      from rodeo_events e
      left join reference_options o
             on o.domain = 'event_type'
            and o.code = e.event_type
            and (o.org_id = ${orgId} or o.org_id is null)
     where e.org_id = ${orgId} and e.rodeo_id = ${rodeoId}
       and e.status = 'active'
     order by e.sort_order, e.event_type
  `;

  // A contestant's name is resolved here rather than in the day sheet engine
  // so the engine stays free of I/O. Back number is not a column anywhere yet;
  // when it becomes one, this is the only place that changes.
  const entryRows = await tx<
    {
      entry_id: string;
      rodeo_event_id: string;
      contestant_id: string;
      contestant_name: string;
      partner_name: string | null;
      horse_name: string | null;
      go_round: number;
      draw_position: number | null;
      performance_number: number | null;
      status: string;
      release_type: string | null;
      reride_pending: boolean;
    }[]
  >`
    select
      en.id                                   as entry_id,
      en.rodeo_event_id,
      en.contestant_id,
      trim(u.first_name || ' ' || u.last_name) as contestant_name,
      case when p.id is null then null
           else trim(p.first_name || ' ' || p.last_name) end as partner_name,
      h.barn_name                             as horse_name,
      en.go_round_number                      as go_round,
      en.draw_position,
      en.performance_number,
      en.status,
      en.release_type,
      exists (
        select 1 from scores s
         where s.entry_id = en.id and s.status = 'reride'
      )                                       as reride_pending
    from entries en
    join users u        on u.id = en.contestant_id
    left join users p   on p.id = en.partner_id
    left join animal_registry h on h.id = en.horse_id
   where en.org_id = ${orgId} and en.rodeo_id = ${rodeoId}
  `;

  const stockRows = await tx<
    {
      entry_id: string;
      go_round: number;
      animal_name: string;
      brand_number: string | null;
    }[]
  >`
    select sd.entry_id, sd.go_round, a.name as animal_name, a.brand_number
      from stock_draws sd
      join animals a on a.id = sd.animal_id
     where sd.org_id = ${orgId} and sd.rodeo_id = ${rodeoId}
       and not sd.is_redraw
  `;

  const personnelRows = await tx<
    {
      role: string;
      name: string;
      card_number: string | null;
      carded: boolean;
    }[]
  >`
    select rp.role,
           trim(u.first_name || ' ' || u.last_name) as name,
           c.card_number,
           (c.id is not null and c.verified)        as carded
      from rodeo_personnel rp
      join users u on u.id = rp.user_id
      left join credentials c on c.id = rp.credential_id
     where rp.org_id = ${orgId} and rp.rodeo_id = ${rodeoId}
     order by rp.role, name
  `;

  const sanctioning = await tx<{ sanctioning_body: string }[]>`
    select sanctioning_body
      from rodeo_sanctioning
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
       and approval_status in ('approved', 'conditional')
     order by sanctioning_body
  `;

  const venue = [rodeo.venue_name, rodeo.venue_city, rodeo.venue_state]
    .filter(Boolean)
    .join(', ');

  return {
    rodeo: {
      id: rodeo.id,
      name: rodeo.name,
      venue: venue || null,
      timezone: rodeo.timezone,
      start_date: rodeo.start_date,
      end_date: rodeo.end_date,
    },
    performance: {
      number: performanceNumber,
      name: perf?.name ?? (performanceNumber === null
        ? 'All performances'
        : `Performance ${performanceNumber}`),
      type: perf?.performance_type ?? 'performance',
      date: perf?.scheduled_start?.slice(0, 10) ?? rodeo.start_date,
      scheduled_start: perf?.scheduled_start ?? null,
      arena_dragged_after: perf?.arena_dragged_after ?? null,
      condensed_drag: perf?.condensed_drag ?? false,
    },
    sanctioned_by: sanctioning.map((s) => s.sanctioning_body),
    events: eventRows.map((e) => ({
      rodeo_event_id: e.id,
      event_type: e.event_type,
      event_label: e.label ?? e.event_type.replace(/_/g, ' '),
      scoring_mode: e.scoring_mode,
      is_roughstock: e.is_roughstock,
      sort_order: e.sort_order,
    })),
    entries: entryRows.map((e) => ({
      entry_id: e.entry_id,
      rodeo_event_id: e.rodeo_event_id,
      contestant_id: e.contestant_id,
      contestant_name: e.contestant_name,
      partner_name: e.partner_name,
      horse_name: e.horse_name,
      go_round: e.go_round,
      draw_position: e.draw_position,
      // The engine keys performances by string; entries carry a number.
      performance_id:
        e.performance_number === null ? null : String(e.performance_number),
      status: e.status,
      release_type: e.release_type,
      reride_pending: e.reride_pending,
    })),
    stock: stockRows,
    personnel: personnelRows,
  };
}

// ===========================================================================
// The books
// ===========================================================================

export interface BooksContext {
  rodeo_name: string;
  last_performance_date: string;
  filing: FilingRule;
  fee_schedule: AssociationFeeSchedule | null;
  association_code: string | null;
  rules_verified: boolean;
  entries: BooksEntryRow[];
  events: BooksEventRow[];
  compliance: BooksComplianceRow[];
  personnel_shortfall: { role: string; required: number; assigned: number }[];
}

/** Events run on the contestant's own horse rather than drawn stock. */
const HORSE_EVENTS = new Set([
  'barrel_racing',
  'pole_bending',
  'breakaway_roping',
  'tie_down_roping',
  'team_roping_header',
  'team_roping_heeler',
  'steer_wrestling',
  'goat_tying',
  'steer_roping',
]);

export async function loadBooks(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<BooksContext | null> {
  const [rodeo] = await tx<{ name: string; end_date: string }[]>`
    select name, end_date::text as end_date
      from rodeos where id = ${rodeoId} and org_id = ${orgId}
  `;
  if (!rodeo) return null;

  // The association whose deadline governs. Where a rodeo is co-approved, the
  // earliest deadline is the one that matters, so the first row by due time
  // wins rather than an arbitrary one.
  const [assoc] = await tx<
    {
      code: string;
      fee_schedule: AssociationFeeSchedule;
      results_due_local_time: string | null;
      results_due_timezone: string | null;
      results_due_day_offset: number;
      late_filing_fine_cents: number | null;
      is_verified: boolean;
    }[]
  >`
    select a.code, a.fee_schedule,
           a.results_due_local_time, a.results_due_timezone,
           a.results_due_day_offset, a.late_filing_fine_cents, a.is_verified
      from rodeo_sanctioning rs
      join associations a on a.id = rs.association_id
     where rs.org_id = ${orgId} and rs.rodeo_id = ${rodeoId}
       and rs.approval_status in ('approved', 'conditional')
     order by (a.results_due_local_time is null),
              a.results_due_day_offset, a.results_due_local_time
     limit 1
  `;

  const entryRows = await tx<
    {
      entry_id: string;
      rodeo_event_id: string;
      event_type: string;
      event_label: string | null;
      contestant_name: string;
      go_round: number;
      status: string;
      draw_position: number | null;
      score_status: string | null;
      entry_fee_amount: string | null;
      fees_paid: boolean;
      horse_id: string | null;
    }[]
  >`
    select
      en.id as entry_id,
      en.rodeo_event_id,
      ev.event_type,
      o.label as event_label,
      trim(u.first_name || ' ' || u.last_name) as contestant_name,
      en.go_round_number as go_round,
      en.status,
      en.draw_position,
      (select s.status from scores s
        where s.entry_id = en.id and s.go_round = en.go_round_number
          and s.status in ('provisional','official','dq','no_time','turned_out','scratched','medical_out')
        order by case s.status when 'official' then 0 else 1 end
        limit 1) as score_status,
      en.entry_fee_amount,
      en.fees_paid,
      en.horse_id
    from entries en
    join users u on u.id = en.contestant_id
    join rodeo_events ev on ev.id = en.rodeo_event_id
    left join reference_options o
           on o.domain = 'event_type' and o.code = ev.event_type
          and (o.org_id = ${orgId} or o.org_id is null)
   where en.org_id = ${orgId} and en.rodeo_id = ${rodeoId}
  `;

  const eventRows = await tx<
    {
      rodeo_event_id: string;
      event_type: string;
      event_label: string | null;
      num_go_rounds: number;
      has_short_go: boolean;
      added_money: string;
      entry_fees: string;
      paid_out: string;
      ground_money: string;
      day_money: string;
      official_rounds: number[];
      average_official: boolean;
    }[]
  >`
    select
      ev.id as rodeo_event_id,
      ev.event_type,
      o.label as event_label,
      ev.num_go_rounds,
      ev.has_short_go,
      ev.added_money as added_money,
      coalesce((
        select sum(en.entry_fee_amount)
          from entries en
         where en.rodeo_event_id = ev.id
           and en.status in ('confirmed','drawn','competed')
      ), 0) as entry_fees,
      coalesce((select sum(r.payout_amount) from results r where r.rodeo_event_id = ev.id), 0) as paid_out,
      coalesce((select sum(r.ground_money) from results r where r.rodeo_event_id = ev.id), 0) as ground_money,
      coalesce((select sum(r.day_money)   from results r where r.rodeo_event_id = ev.id), 0) as day_money,
      coalesce((
        select array_agg(distinct r.go_round)
          from results r
         where r.rodeo_event_id = ev.id and r.result_type = 'go_round'
           and r.is_official and r.go_round is not null
      ), '{}') as official_rounds,
      exists (
        select 1 from results r
         where r.rodeo_event_id = ev.id
           and r.result_type in ('average','aggregate') and r.is_official
      ) as average_official
    from rodeo_events ev
    left join reference_options o
           on o.domain = 'event_type' and o.code = ev.event_type
          and (o.org_id = ${orgId} or o.org_id is null)
   where ev.org_id = ${orgId} and ev.rodeo_id = ${rodeoId}
     and ev.status = 'active'
   order by ev.sort_order
  `;

  const compliance = await tx<BooksComplianceRow[]>`
    select code, label, requirement_type, status, blocks_close,
           due_on::text as due_on
      from rodeo_compliance_items
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by due_on nulls last, code
  `;

  const shortfall = await tx<
    { role: string; required: number; assigned: number }[]
  >`
    select role, required, assigned
      from personnel_shortfall(${orgId}, ${rodeoId})
  `;

  return {
    rodeo_name: rodeo.name,
    last_performance_date: rodeo.end_date,
    filing: {
      local_time: assoc?.results_due_local_time ?? null,
      timezone: assoc?.results_due_timezone ?? null,
      day_offset: assoc?.results_due_day_offset ?? 0,
      late_fee_cents: assoc?.late_filing_fine_cents ?? null,
    },
    fee_schedule: assoc?.fee_schedule ?? null,
    association_code: assoc?.code ?? null,
    rules_verified: assoc?.is_verified ?? true,
    entries: entryRows.map((e) => {
      const charged = cents(e.entry_fee_amount);
      return {
        entry_id: e.entry_id,
        rodeo_event_id: e.rodeo_event_id,
        event_label: e.event_label ?? e.event_type.replace(/_/g, ' '),
        contestant_name: e.contestant_name,
        go_round: e.go_round,
        status: e.status,
        draw_position: e.draw_position,
        score_status: e.score_status,
        fee_charged_cents: charged,
        // No partial payments in the schema: an entry is paid or it is not.
        fee_collected_cents: e.fees_paid ? charged : 0,
        needs_horse: HORSE_EVENTS.has(e.event_type),
        horse_id: e.horse_id,
      };
    }),
    events: eventRows.map((e) => ({
      rodeo_event_id: e.rodeo_event_id,
      event_label: e.event_label ?? e.event_type.replace(/_/g, ' '),
      go_rounds: Array.from({ length: e.num_go_rounds }, (_, i) => i + 1),
      added_money_cents: cents(e.added_money),
      entry_fees_cents: cents(e.entry_fees),
      paid_out_cents: cents(e.paid_out),
      ground_money_cents: cents(e.ground_money),
      day_money_cents: cents(e.day_money),
      official_result_rounds: e.official_rounds ?? [],
      average_official: e.average_official,
      // The average exists when there is more than one round, or a short go.
      has_average: e.num_go_rounds > 1 || e.has_short_go,
    })),
    compliance,
    personnel_shortfall: shortfall,
  };
}

export interface ClosureRow {
  id: string;
  sequence: number;
  closure_type: string;
  occurred_at: string;
  net_purse_cents: string;
  paid_out_cents: string;
  totals_hash: string;
  filing_reference: string | null;
}

export async function closeBooks(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  actorId: string | null,
  totals: Record<string, number>,
  warnings: unknown[],
  associationCode: string | null,
  dueAt: string | null,
): Promise<ClosureRow> {
  const [row] = await tx<ClosureRow[]>`
    select id, sequence, closure_type, occurred_at::text as occurred_at,
           net_purse_cents::text as net_purse_cents,
           paid_out_cents::text as paid_out_cents,
           totals_hash, filing_reference
      from close_rodeo_books(
        ${orgId}, ${rodeoId}, ${actorId},
        ${tx.json(totals as unknown as Json)},
        ${tx.json(warnings as unknown as Json)},
        ${associationCode}, ${dueAt}
      )
  `;
  return row;
}

export async function fileBooks(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  actorId: string | null,
  reference: string | null,
  late: boolean,
  lateFeeCents: number | null,
): Promise<ClosureRow> {
  const [row] = await tx<ClosureRow[]>`
    select id, sequence, closure_type, occurred_at::text as occurred_at,
           net_purse_cents::text as net_purse_cents,
           paid_out_cents::text as paid_out_cents,
           totals_hash, filing_reference
      from file_rodeo_books(${orgId}, ${rodeoId}, ${actorId}, ${reference},
                            ${late}, ${lateFeeCents})
  `;
  return row;
}

export async function reopenBooks(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  actorId: string | null,
  reason: string,
): Promise<ClosureRow> {
  const [row] = await tx<ClosureRow[]>`
    select id, sequence, closure_type, occurred_at::text as occurred_at,
           net_purse_cents::text as net_purse_cents,
           paid_out_cents::text as paid_out_cents,
           totals_hash, filing_reference
      from reopen_rodeo_books(${orgId}, ${rodeoId}, ${actorId}, ${reason})
  `;
  return row;
}

export async function loadBookState(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<{ state: string; sequence: number; occurred_at: string } | null> {
  const [row] = await tx<{ state: string; sequence: number; occurred_at: string }[]>`
    select state, sequence, occurred_at::text as occurred_at
      from rodeo_book_state
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
  `;
  return row ?? null;
}

// ===========================================================================
// Associations and compliance
// ===========================================================================

export interface AssociationRow {
  id: string;
  code: string;
  name: string;
  short_name: string | null;
  association_type: string;
  country: string;
  event_codes: string[];
  membership_classes: unknown;
  required_credentials: unknown;
  fee_schedule: unknown;
  results_due_local_time: string | null;
  results_due_timezone: string | null;
  late_filing_fine_cents: number | null;
  mandates_own_system: boolean;
  system_carve_out: string | null;
  is_verified: boolean;
  verified_against: string | null;
  notes: string | null;
  is_custom: boolean;
}

export async function loadAssociations(
  tx: Tx,
  orgId: string,
): Promise<AssociationRow[]> {
  return tx<AssociationRow[]>`
    select id, code, name, short_name, association_type, country,
           event_codes, membership_classes, required_credentials, fee_schedule,
           results_due_local_time, results_due_timezone, late_filing_fine_cents,
           mandates_own_system, system_carve_out,
           is_verified, verified_against, notes,
           (org_id is not null) as is_custom
      from associations
     where is_active and (org_id is null or org_id = ${orgId})
     order by (org_id is not null) desc, association_type, code
  `;
}

export async function loadAssociationRequirements(
  tx: Tx,
  associationId: string,
): Promise<
  {
    code: string;
    label: string;
    description: string | null;
    requirement_type: string;
    due_anchor: string;
    due_offset_days: number;
    blocks_close: boolean;
    late_fee_cents: number | null;
    is_verified: boolean;
  }[]
> {
  return tx`
    select code, label, description, requirement_type, due_anchor,
           due_offset_days, blocks_close, late_fee_cents, is_verified
      from association_requirements
     where association_id = ${associationId} and is_active
     order by sort_order, code
  `;
}

export async function generateCompliance(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<number> {
  const [row] = await tx<{ generate_compliance_items: number }[]>`
    select generate_compliance_items(${orgId}, ${rodeoId})
  `;
  return row?.generate_compliance_items ?? 0;
}

export interface ComplianceItemRow {
  id: string;
  code: string;
  label: string;
  requirement_type: string;
  association_code: string | null;
  blocks_close: boolean;
  due_on: string | null;
  status: string;
  evidence_url: string | null;
  amount_cents: string | null;
  notes: string | null;
}

export async function loadCompliance(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<ComplianceItemRow[]> {
  return tx<ComplianceItemRow[]>`
    select id, code, label, requirement_type, association_code, blocks_close,
           due_on::text as due_on, status, evidence_url,
           amount_cents::text as amount_cents, notes
      from rodeo_compliance_items
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by due_on nulls last, code
  `;
}

export async function updateComplianceItem(
  tx: Tx,
  orgId: string,
  itemId: string,
  patch: {
    status?: string;
    evidence_url?: string | null;
    amount_cents?: number | null;
    waived_reason?: string | null;
    notes?: string | null;
    actor_id?: string | null;
  },
): Promise<ComplianceItemRow | null> {
  const satisfied = patch.status === 'satisfied';
  const [row] = await tx<ComplianceItemRow[]>`
    update rodeo_compliance_items
       set status        = coalesce(${patch.status ?? null}, status),
           evidence_url  = coalesce(${patch.evidence_url ?? null}, evidence_url),
           amount_cents  = coalesce(${patch.amount_cents ?? null}, amount_cents),
           waived_reason = coalesce(${patch.waived_reason ?? null}, waived_reason),
           notes         = coalesce(${patch.notes ?? null}, notes),
           satisfied_at  = case when ${satisfied} then now() else satisfied_at end,
           satisfied_by  = case when ${satisfied} then ${patch.actor_id ?? null}::uuid
                                else satisfied_by end
     where id = ${itemId} and org_id = ${orgId}
    returning id, code, label, requirement_type, association_code, blocks_close,
              due_on::text as due_on, status, evidence_url,
              amount_cents::text as amount_cents, notes
  `;
  return row ?? null;
}

// ===========================================================================
// The record layer
// ===========================================================================

export interface CareerRunRow {
  id: string;
  rodeo_name: string;
  event_code: string;
  run_date: string;
  venue_city: string | null;
  venue_state: string | null;
  association_code: string | null;
  result_type: string;
  go_round: number | null;
  place: number | null;
  earnings_cents: string;
  points: string;
  animal_name: string | null;
  source: string;
  is_verified: boolean;
}

/**
 * A person's whole record, across every organisation.
 *
 * RLS decides what comes back: a contestant reading their own id gets
 * everything; anybody else gets only the runs recorded at organisations they
 * are staff of. There is no policy anywhere that returns another person's
 * complete career.
 */
export async function loadCareer(
  tx: Tx,
  contestantId: string,
  limit = 500,
): Promise<CareerRunRow[]> {
  return tx<CareerRunRow[]>`
    select cr.id, cr.rodeo_name, cr.event_code, cr.run_date::text as run_date,
           cr.venue_city, cr.venue_state, cr.association_code,
           cr.result_type, cr.go_round, cr.place,
           cr.earnings_cents::text as earnings_cents,
           cr.points::text as points,
           ar.barn_name as animal_name,
           cr.source, cr.is_verified
      from career_runs cr
      left join animal_registry ar on ar.id = cr.animal_id
     where cr.contestant_id = ${contestantId}
     order by cr.run_date desc, cr.rodeo_name
     limit ${limit}
  `;
}

export async function careerSummary(
  tx: Tx,
  contestantId: string,
): Promise<
  { season: string; event_code: string; runs: number; earnings_cents: string }[]
> {
  return tx`
    select extract(year from run_date)::text as season,
           event_code,
           count(*)::int as runs,
           sum(earnings_cents)::text as earnings_cents
      from career_runs
     where contestant_id = ${contestantId}
     group by season, event_code
     order by season desc, event_code
  `;
}

export interface RegistryAnimalRow {
  id: string;
  barn_name: string;
  registered_name: string | null;
  animal_type: string;
  breed: string | null;
  sex: string | null;
  foaled_year: number | null;
  owner_user_id: string | null;
  is_claimed: boolean;
}

export async function searchRegistry(
  tx: Tx,
  query: string,
  animalType: string | null,
  limit = 25,
): Promise<RegistryAnimalRow[]> {
  const like = `%${query.toLowerCase()}%`;
  return tx<RegistryAnimalRow[]>`
    select id, barn_name, registered_name, animal_type, breed, sex,
           foaled_year, owner_user_id, is_claimed
      from animal_registry
     where (lower(barn_name) like ${like}
            or lower(coalesce(registered_name, '')) like ${like})
       and (${animalType}::text is null or animal_type = ${animalType})
       and deceased_at is null
     order by barn_name
     limit ${limit}
  `;
}

export async function createRegistryAnimal(
  tx: Tx,
  orgId: string | null,
  input: {
    barn_name: string;
    registered_name?: string | null;
    animal_type: string;
    breed?: string | null;
    sex?: string | null;
    foaled_year?: number | null;
    owner_user_id?: string | null;
  },
): Promise<RegistryAnimalRow> {
  const [row] = await tx<RegistryAnimalRow[]>`
    insert into animal_registry
      (barn_name, registered_name, animal_type, breed, sex, foaled_year,
       owner_user_id, created_by_org)
    values
      (${input.barn_name}, ${input.registered_name ?? null}, ${input.animal_type},
       ${input.breed ?? null}, ${input.sex ?? null}, ${input.foaled_year ?? null},
       ${input.owner_user_id ?? null}, ${orgId})
    returning id, barn_name, registered_name, animal_type, breed, sex,
              foaled_year, owner_user_id, is_claimed
  `;
  return row;
}

export async function animalCareer(
  tx: Tx,
  animalId: string,
): Promise<{
  animal_id: string;
  barn_name: string;
  runs: number;
  wins: number;
  best_place: number | null;
  earnings_cents: string;
} | null> {
  const [row] = await tx<
    {
      animal_id: string;
      barn_name: string;
      runs: number;
      wins: number;
      best_place: number | null;
      earnings_cents: string;
    }[]
  >`
    select animal_id, barn_name, runs::int, wins::int, best_place,
           coalesce(earnings_cents, 0)::text as earnings_cents
      from public_animal_career
     where animal_id = ${animalId}
  `;
  return row ?? null;
}

// ===========================================================================
// Creating a rodeo
//
// The setup screen is five dropdowns and one submit, so this is one
// transaction: the rodeo, its sanctioning, its events, and the compliance
// checklist that follows from the sanctioning. A secretary who has to create a
// rodeo and then remember to add events to it has been given a database, not a
// product.
// ===========================================================================

export interface NewRodeoEvent {
  event_type: string;
  scoring_mode: 'judged' | 'timed';
  is_roughstock?: boolean;
  entry_fee?: number;
  added_money?: number;
  stock_charge?: number;
  num_go_rounds?: number;
  scoring_config_id?: string | null;
  payout_config_id?: string | null;
}

export interface NewRodeo {
  name: string;
  slug: string;
  rodeo_type: string;
  start_date: string;
  end_date: string;
  timezone?: string;
  venue_name?: string | null;
  venue_city?: string | null;
  venue_state?: string | null;
  num_performances?: number;
  num_go_rounds?: number;
  sanctioning?: string[];
  events: NewRodeoEvent[];
}

export interface CreatedRodeo {
  id: string;
  name: string;
  slug: string;
  status: string;
  events: { id: string; event_type: string }[];
  compliance_items: number;
}

/**
 * The rule set an event gets when the producer did not choose one.
 *
 * Preference order, most specific first: the tenant's own config for this body
 * and event, the system config for this body and event, any config for the
 * event, then nothing. Never a guess across event types — a bareback config
 * applied to barrel racing would score every run wrong and look like it
 * worked.
 */
async function defaultScoringConfig(
  tx: Tx,
  orgId: string,
  eventType: string,
  body: string | null,
): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    select id from scoring_configs
     where (org_id = ${orgId} or org_id is null)
       and event_type = ${eventType}
       and (${body}::text is null or sanctioning_body = ${body} or sanctioning_body is null)
     order by (org_id is not null) desc,
              (sanctioning_body = ${body}) desc nulls last,
              effective_date desc nulls last
     limit 1
  `;
  return row?.id ?? null;
}

/** Payout ladders are per body, or generic. Same preference order. */
async function defaultPayoutConfig(
  tx: Tx,
  orgId: string,
  body: string | null,
): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    select id from payout_configs
     where (org_id = ${orgId} or org_id is null)
       and (${body}::text is null or sanctioning_body = ${body} or sanctioning_body is null)
     order by (org_id is not null) desc,
              (sanctioning_body = ${body}) desc nulls last,
              effective_date desc nulls last
     limit 1
  `;
  return row?.id ?? null;
}

export async function createRodeo(
  tx: Tx,
  orgId: string,
  input: NewRodeo,
): Promise<CreatedRodeo> {
  const [rodeo] = await tx<{ id: string; name: string; slug: string; status: string }[]>`
    insert into rodeos (org_id, name, slug, rodeo_type, start_date, end_date,
                        timezone, venue_name, venue_city, venue_state,
                        num_performances, num_go_rounds)
    values (${orgId}, ${input.name}, ${input.slug}, ${input.rodeo_type},
            ${input.start_date}, ${input.end_date},
            ${input.timezone ?? 'America/Denver'},
            ${input.venue_name ?? null}, ${input.venue_city ?? null},
            ${input.venue_state ?? null},
            ${input.num_performances ?? 1}, ${input.num_go_rounds ?? 1})
    returning id, name, slug, status
  `;

  // Sanctioning first: the compliance checklist is generated from it, and an
  // association that is added after the events would produce an empty one.
  for (const body of input.sanctioning ?? []) {
    await tx`
      insert into rodeo_sanctioning (org_id, rodeo_id, sanctioning_body,
                                     approval_status, association_id)
      select ${orgId}, ${rodeo.id}, ${body}, 'pending', a.id
        from (select id from associations
               where code = ${body} and is_active
                 and (org_id = ${orgId} or org_id is null)
               order by (org_id is not null) desc limit 1) a
    `;
  }

  // The first sanctioning body decides which rule set an event gets by
  // default. Without this, an event created by the setup wizard carries no
  // scoring config and the first score submitted against it is rejected — a
  // rodeo you can create but cannot score is worse than no wizard at all.
  const primaryBody = input.sanctioning?.[0] ?? null;

  const events: { id: string; event_type: string }[] = [];
  let sortOrder = 0;
  for (const ev of input.events) {
    sortOrder += 10;
    const scoringConfigId =
      ev.scoring_config_id ??
      (await defaultScoringConfig(tx, orgId, ev.event_type, primaryBody));
    const payoutConfigId =
      ev.payout_config_id ?? (await defaultPayoutConfig(tx, orgId, primaryBody));
    const [row] = await tx<{ id: string; event_type: string }[]>`
      insert into rodeo_events (org_id, rodeo_id, event_type, scoring_mode,
                                is_roughstock, entry_fee, added_money,
                                stock_charge, num_go_rounds, sort_order,
                                scoring_config_id, payout_config_id)
      values (${orgId}, ${rodeo.id}, ${ev.event_type}, ${ev.scoring_mode},
              ${ev.is_roughstock ?? false}, ${ev.entry_fee ?? 0},
              ${ev.added_money ?? 0}, ${ev.stock_charge ?? 0},
              ${ev.num_go_rounds ?? input.num_go_rounds ?? 1}, ${sortOrder},
              ${scoringConfigId}, ${payoutConfigId})
      returning id, event_type
    `;
    events.push(row);
  }

  // Zero for a jackpot, and that silence is the design.
  const complianceItems = await generateCompliance(tx, orgId, rodeo.id);

  return { ...rodeo, events, compliance_items: complianceItems };
}

export interface RodeoSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  rodeo_type: string;
  start_date: string;
  end_date: string;
  venue_city: string | null;
  venue_state: string | null;
  event_count: number;
  entry_count: number;
  sanctioned_by: string[];
  book_state: string | null;
}

export async function listRodeos(
  tx: Tx,
  orgId: string,
  limit = 50,
): Promise<RodeoSummary[]> {
  return tx<RodeoSummary[]>`
    select r.id, r.name, r.slug, r.status, r.rodeo_type,
           r.start_date::text as start_date, r.end_date::text as end_date,
           r.venue_city, r.venue_state,
           (select count(*) from rodeo_events e
             where e.rodeo_id = r.id and e.status = 'active')::int as event_count,
           (select count(*) from entries en where en.rodeo_id = r.id)::int as entry_count,
           coalesce((select array_agg(s.sanctioning_body order by s.sanctioning_body)
                       from rodeo_sanctioning s where s.rodeo_id = r.id), '{}') as sanctioned_by,
           (select bs.state from rodeo_book_state bs where bs.rodeo_id = r.id) as book_state
      from rodeos r
     where r.org_id = ${orgId}
     order by r.start_date desc
     limit ${limit}
  `;
}

export interface RodeoDetail extends RodeoSummary {
  timezone: string;
  events: {
    id: string;
    event_type: string;
    label: string | null;
    scoring_mode: string;
    is_roughstock: boolean;
    entry_fee: string;
    added_money: string;
    num_go_rounds: number;
    entries: number;
    scored: number;
  }[];
  performances: { performance_number: number; name: string | null; performance_type: string }[];
}

export async function loadRodeo(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<RodeoDetail | null> {
  const [summary] = await listRodeosById(tx, orgId, rodeoId);
  if (!summary) return null;

  const events = await tx<RodeoDetail['events']>`
    select e.id, e.event_type, o.label, e.scoring_mode, e.is_roughstock,
           e.entry_fee::text as entry_fee, e.added_money::text as added_money,
           e.num_go_rounds,
           (select count(*) from entries en
             where en.rodeo_event_id = e.id
               and en.status in ('confirmed','drawn','competed'))::int as entries,
           (select count(*) from scores s
             where s.rodeo_event_id = e.id
               and s.status in ('provisional','official'))::int as scored
      from rodeo_events e
      left join reference_options o
             on o.domain = 'event_type' and o.code = e.event_type
            and (o.org_id = ${orgId} or o.org_id is null)
     where e.org_id = ${orgId} and e.rodeo_id = ${rodeoId} and e.status = 'active'
     order by e.sort_order
  `;

  const performances = await tx<RodeoDetail['performances']>`
    select performance_number, name, performance_type
      from performances
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by performance_number
  `;

  const [detail] = await tx<{ timezone: string }[]>`
    select timezone from rodeos where id = ${rodeoId} and org_id = ${orgId}
  `;

  return { ...summary, timezone: detail.timezone, events, performances };
}

async function listRodeosById(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<RodeoSummary[]> {
  return tx<RodeoSummary[]>`
    select r.id, r.name, r.slug, r.status, r.rodeo_type,
           r.start_date::text as start_date, r.end_date::text as end_date,
           r.venue_city, r.venue_state,
           (select count(*) from rodeo_events e
             where e.rodeo_id = r.id and e.status = 'active')::int as event_count,
           (select count(*) from entries en where en.rodeo_id = r.id)::int as entry_count,
           coalesce((select array_agg(s.sanctioning_body order by s.sanctioning_body)
                       from rodeo_sanctioning s where s.rodeo_id = r.id), '{}') as sanctioned_by,
           (select bs.state from rodeo_book_state bs where bs.rodeo_id = r.id) as book_state
      from rodeos r
     where r.org_id = ${orgId} and r.id = ${rodeoId}
  `;
}

// ===========================================================================
// Results, stock and personnel — the three screens the interface still lacked
// ===========================================================================

export interface ResultDisplayRow {
  rodeo_event_id: string;
  event_label: string;
  result_type: string;
  go_round: number | null;
  d_division: number | null;
  place: number | null;
  contestant_id: string;
  contestant_name: string;
  aggregate_score: string | null;
  payout_amount: string;
  points_earned: string;
  is_official: boolean;
}

export async function loadResults(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<ResultDisplayRow[]> {
  return tx<ResultDisplayRow[]>`
    select r.rodeo_event_id,
           coalesce(o.label, replace(ev.event_type, '_', ' ')) as event_label,
           r.result_type, r.go_round, r.d_division, r.place,
           r.contestant_id,
           trim(u.first_name || ' ' || u.last_name) as contestant_name,
           r.aggregate_score::text as aggregate_score,
           r.payout_amount::text as payout_amount,
           r.points_earned::text as points_earned,
           r.is_official
      from results r
      join rodeo_events ev on ev.id = r.rodeo_event_id
      join users u on u.id = r.contestant_id
      left join reference_options o
             on o.domain = 'event_type' and o.code = ev.event_type
            and (o.org_id = ${orgId} or o.org_id is null)
     where r.org_id = ${orgId} and r.rodeo_id = ${rodeoId}
     order by ev.sort_order, r.result_type, r.go_round nulls first,
              r.d_division nulls first, r.place nulls last
  `;
}

/** Publish or unpublish a whole event's placings in one action. */
export async function setResultsOfficial(
  tx: Tx,
  orgId: string,
  eventId: string,
  official: boolean,
): Promise<number> {
  const rows = await tx`
    update results set is_official = ${official}, updated_at = now()
     where org_id = ${orgId} and rodeo_event_id = ${eventId}
  `;
  return rows.count;
}

// ---- Stock -----------------------------------------------------------------

export interface AnimalRow {
  id: string;
  name: string;
  brand_number: string | null;
  animal_type: string;
  breed: string | null;
  health_status: string;
  registry_id: string | null;
  contractor_name: string | null;
  /** Times drawn at this rodeo. */
  drawn_here: number;
}

export async function listAnimals(
  tx: Tx,
  orgId: string,
  rodeoId: string | null,
): Promise<AnimalRow[]> {
  return tx<AnimalRow[]>`
    select a.id, a.name, a.brand_number, a.animal_type, a.breed,
           a.health_status, a.registry_id,
           case when c.id is null then null
                else trim(c.first_name || ' ' || c.last_name) end as contractor_name,
           coalesce(d.n, 0)::int as drawn_here
      from animals a
      left join users c on c.id = a.contractor_id
      left join lateral (
        select count(*) as n from stock_draws sd
         where sd.animal_id = a.id
           and (${rodeoId}::uuid is null or sd.rodeo_id = ${rodeoId})
           and not sd.is_redraw
      ) d on true
     where a.org_id = ${orgId}
     order by a.animal_type, a.name
  `;
}

export interface NewAnimal {
  name: string;
  animal_type: string;
  brand_number?: string | null;
  breed?: string | null;
  contractor_id?: string | null;
  registry_id?: string | null;
}

export async function createAnimal(
  tx: Tx,
  orgId: string,
  input: NewAnimal,
): Promise<{ id: string; name: string }> {
  const [row] = await tx<{ id: string; name: string }[]>`
    insert into animals (org_id, name, animal_type, brand_number, breed,
                         contractor_id, registry_id)
    values (${orgId}, ${input.name}, ${input.animal_type},
            ${input.brand_number ?? null}, ${input.breed ?? null},
            ${input.contractor_id ?? null}, ${input.registry_id ?? null})
    returning id, name
  `;
  return row;
}

export async function setAnimalHealth(
  tx: Tx,
  orgId: string,
  animalId: string,
  status: string,
): Promise<boolean> {
  const rows = await tx`
    update animals set health_status = ${status}, updated_at = now()
     where id = ${animalId} and org_id = ${orgId}
  `;
  return rows.count > 0;
}

// ---- Personnel -------------------------------------------------------------

export interface PersonnelRow {
  id: string;
  user_id: string;
  name: string;
  role: string;
  credential_id: string | null;
  card_number: string | null;
  card_expires: string | null;
  carded: boolean;
  confirmed_at: string | null;
  fee_cents: string | null;
}

export async function listPersonnel(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<PersonnelRow[]> {
  return tx<PersonnelRow[]>`
    select rp.id, rp.user_id,
           trim(u.first_name || ' ' || u.last_name) as name,
           rp.role, c.id as credential_id,
           c.card_number, c.expires_on::text as card_expires,
           coalesce(c.verified, false) as carded,
           rp.confirmed_at::text as confirmed_at,
           rp.fee_cents::text as fee_cents
      from rodeo_personnel rp
      join users u on u.id = rp.user_id
      -- Resolved LIVE, not read from rp.credential_id. Snapshotting it at
      -- assignment meant a card verified afterwards never showed up, and the
      -- rodeo stayed 'short' with a carded judge standing in the arena. The
      -- shortfall function checks credentials directly for the same reason.
      left join lateral (
        select cr.id, cr.card_number, cr.expires_on, cr.verified
          from credentials cr
          left join rodeo_sanctioning rs
                 on rs.rodeo_id = rp.rodeo_id and rs.org_id = rp.org_id
          left join associations a on a.id = rs.association_id
         where cr.user_id = rp.user_id
           and cr.role = rp.role
           and (a.code is null or cr.body_code = a.code)
         order by cr.verified desc, cr.expires_on desc nulls last
         limit 1
      ) c on true
     where rp.org_id = ${orgId} and rp.rodeo_id = ${rodeoId}
     order by rp.role, u.last_name, u.first_name
  `;
}

/**
 * Put somebody on a rodeo, attaching their card automatically.
 *
 * The credential is resolved here rather than asked for: a secretary assigning
 * a judge should not have to know his card number, and a shortfall report that
 * depends on somebody remembering to link the card is a report that will
 * always say the rodeo is short.
 */
export async function assignPersonnel(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  userId: string,
  role: string,
  feeCents: number | null,
): Promise<PersonnelRow | null> {
  const [row] = await tx<{ id: string }[]>`
    insert into rodeo_personnel (org_id, rodeo_id, user_id, role, fee_cents,
                                 credential_id)
    values (${orgId}, ${rodeoId}, ${userId}, ${role}, ${feeCents},
            (select c.id from credentials c
              join rodeo_sanctioning rs
                on rs.rodeo_id = ${rodeoId} and rs.org_id = ${orgId}
              join associations a on a.id = rs.association_id
             where c.user_id = ${userId}
               and c.role = ${role}
               and c.body_code = a.code
               and c.verified
             order by c.expires_on desc nulls last
             limit 1))
    on conflict (rodeo_id, user_id, role) do update
       set fee_cents = excluded.fee_cents, updated_at = now()
    returning id
  `;
  if (!row) return null;
  const all = await listPersonnel(tx, orgId, rodeoId);
  return all.find((p) => p.id === row.id) ?? null;
}

export async function removePersonnel(
  tx: Tx,
  orgId: string,
  personnelId: string,
): Promise<boolean> {
  const rows = await tx`
    delete from rodeo_personnel where id = ${personnelId} and org_id = ${orgId}
  `;
  return rows.count > 0;
}

export async function listCredentials(
  tx: Tx,
  userId: string,
): Promise<
  {
    id: string;
    body_code: string;
    role: string;
    card_number: string | null;
    card_class: string;
    expires_on: string | null;
    verified: boolean;
  }[]
> {
  return tx`
    select id, body_code, role, card_number, card_class,
           expires_on::text as expires_on, verified
      from credentials where user_id = ${userId}
     order by body_code, role
  `;
}

export async function addCredential(
  tx: Tx,
  userId: string,
  input: {
    body_code: string;
    role: string;
    card_number?: string | null;
    card_class?: string;
    issued_on?: string | null;
    expires_on?: string | null;
  },
): Promise<{ id: string }> {
  const [row] = await tx<{ id: string }[]>`
    insert into credentials (user_id, body_code, role, card_number, card_class,
                             issued_on, expires_on, association_id)
    values (${userId}, ${input.body_code}, ${input.role},
            ${input.card_number ?? null}, ${input.card_class ?? 'full'},
            ${input.issued_on ?? null}, ${input.expires_on ?? null},
            (select id from associations
              where code = ${input.body_code} and org_id is null limit 1))
    returning id
  `;
  return row;
}

/**
 * Mark a card as checked.
 *
 * Separate from adding it, on purpose. Anybody can type a number into a box;
 * `credential_is_current()` counts only a card somebody has verified, so this
 * is the step that makes the shortfall report mean something.
 */
export async function verifyCredential(
  tx: Tx,
  credentialId: string,
  _actorId: string,
): Promise<boolean> {
  // Goes through verify_credential() rather than an UPDATE. The check —
  // nobody verifies their own card, and the verifier must be staff somewhere
  // that deals with the holder — lives in one function instead of being
  // tangled into a policy's WITH CHECK clause. See delta D40.
  const [row] = await tx<{ verify_credential: boolean }[]>`
    select verify_credential(${credentialId})
  `;
  return row?.verify_credential ?? false;
}
