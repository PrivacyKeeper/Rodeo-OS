/**
 * Repositories — the storage layer the API modules declare and depend on.
 *
 * Every function here runs inside a transaction that already carries the
 * caller's verified identity, so RLS is doing the tenant filtering. The
 * queries still pass org_id where it narrows an index, but they do not rely on
 * it for isolation: if a handler forgot the predicate entirely, the policy
 * would still return nothing from another tenant.
 *
 * All interpolation is via postgres.js tagged templates, which bind values as
 * parameters. There is no string-built SQL in this file.
 *
 * JSONB: always `tx.json(value)`, never `JSON.stringify(value)::jsonb`. The
 * second form binds a TEXT parameter, so the cast produces a jsonb *string
 * scalar* rather than an object — `jsonb_typeof` returns 'string' and reading
 * it back yields a JS string. Every config, judge card and metadata blob would
 * round-trip as unusable text. Caught by the integration tests; see
 * docs/SPEC-DELTAS.md D26.
 */

import type { Json, Tx } from './client.ts';
import type {
  Entryish,
  PayoutConfig,
  Rankable,
  ScoringConfig,
  ScoringMode,
} from '@rodeo-os/engine';

// ===========================================================================
// Options
// ===========================================================================

export interface StoredOption {
  domain: string;
  code: string;
  label: string;
  description: string | null;
  category: string | null;
  sort_order: number;
  metadata: Record<string, unknown>;
  is_custom: boolean;
}

export async function loadAllOptions(tx: Tx, orgId: string): Promise<StoredOption[]> {
  const rows = await tx<StoredOption[]>`
    select domain, code, label, description, category, sort_order, metadata,
           (org_id is not null) as is_custom
      from reference_options
     where is_active
       and (org_id is null or org_id = ${orgId})
     order by domain, sort_order, label
  `;
  return rows;
}

export async function loadOptions(
  tx: Tx,
  orgId: string,
  domain: string,
): Promise<StoredOption[]> {
  return tx<StoredOption[]>`
    select domain, code, label, description, category, sort_order, metadata,
           (org_id is not null) as is_custom
      from reference_options
     where is_active
       and domain = ${domain}
       and (org_id is null or org_id = ${orgId})
     order by sort_order, label
  `;
}

export async function createOption(
  tx: Tx,
  orgId: string,
  domain: string,
  body: {
    code: string;
    label: string;
    description?: string;
    category?: string;
    sort_order?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<StoredOption> {
  const [row] = await tx<StoredOption[]>`
    insert into reference_options
      (domain, code, label, description, category, sort_order, metadata,
       org_id, is_system)
    values
      (${domain}, ${body.code}, ${body.label}, ${body.description ?? null},
       ${body.category ?? null}, ${body.sort_order ?? 1000},
       ${tx.json((body.metadata ?? {}) as Json)}, ${orgId}, false)
    returning domain, code, label, description, category, sort_order, metadata,
              true as is_custom
  `;
  return row;
}

/**
 * Only a producer's OWN options are reachable here. A system option has
 * org_id null and the predicate excludes it, so the route returns 404 rather
 * than silently doing nothing.
 */
export async function updateOption(
  tx: Tx,
  orgId: string,
  domain: string,
  code: string,
  body: { label?: string; is_active?: boolean; sort_order?: number },
): Promise<StoredOption | null> {
  const [row] = await tx<StoredOption[]>`
    update reference_options
       set label      = coalesce(${body.label ?? null}, label),
           is_active  = coalesce(${body.is_active ?? null}, is_active),
           sort_order = coalesce(${body.sort_order ?? null}, sort_order)
     where domain = ${domain}
       and code = ${code}
       and org_id = ${orgId}
    returning domain, code, label, description, category, sort_order, metadata,
              true as is_custom
  `;
  return row ?? null;
}

// ===========================================================================
// Scoring
// ===========================================================================

export async function loadScoringConfig(
  tx: Tx,
  configId: string,
): Promise<ScoringConfig | null> {
  const [row] = await tx<{ config: ScoringConfig; sanctioning_body: string | null }[]>`
    select config, sanctioning_body
      from scoring_configs
     where id = ${configId}
  `;
  if (!row) return null;
  return { ...row.config, id: configId, sanctioning_body: row.sanctioning_body };
}

export interface PersistScoreInput {
  id: string;
  org_id: string;
  rodeo_id: string;
  rodeo_event_id: string;
  entry_id: string;
  contestant_id: string;
  go_round: number;
  performance?: number;
  animal_id?: string;
  scoring_config_id: string;
  source: string;
  hardware_timestamp?: number;
  entered_by: string;
  result: {
    kind: 'judged' | 'timed';
    status: string;
    dq_reason?: string;
    final_score?: number | null;
    rider_score?: number | null;
    animal_score?: number | null;
    judge_scores?: unknown;
    raw_time?: number | null;
    final_time?: number | null;
    penalties_applied?: unknown;
  };
}

export async function persistScore(tx: Tx, input: PersistScoreInput): Promise<void> {
  const r = input.result;
  const judged = r.kind === 'judged';

  await tx`
    insert into scores (
      id, org_id, rodeo_id, rodeo_event_id, entry_id, contestant_id,
      go_round, performance, animal_id,
      raw_time, time_penalties, final_time,
      judge_scores, final_score, animal_score,
      status, dq_reason, source, hardware_timestamp,
      scoring_config_id, entered_by
    ) values (
      ${input.id}, ${input.org_id}, ${input.rodeo_id}, ${input.rodeo_event_id},
      ${input.entry_id}, ${input.contestant_id},
      ${input.go_round}, ${input.performance ?? null}, ${input.animal_id ?? null},
      ${judged ? null : (r.raw_time ?? null)},
      ${tx.json((judged ? [] : (r.penalties_applied ?? [])) as Json)},
      ${judged ? null : (r.final_time ?? null)},
      ${tx.json((judged ? (r.judge_scores ?? []) : []) as Json)},
      ${judged ? (r.final_score ?? null) : null},
      ${judged ? (r.animal_score ?? null) : null},
      ${r.status}, ${r.dq_reason ?? null}, ${input.source},
      ${input.hardware_timestamp ?? null},
      ${input.scoring_config_id}, ${input.entered_by}
    )
  `;
}

export async function finalizeScore(
  tx: Tx,
  orgId: string,
  scoreId: string,
  actorId: string,
): Promise<{ id: string; rodeo_event_id: string; status: string } | null> {
  const [row] = await tx<{ id: string; rodeo_event_id: string; status: string }[]>`
    update scores
       set status = 'official', last_edited_by = ${actorId}
     where id = ${scoreId}
       and org_id = ${orgId}
       and status = 'provisional'
    returning id, rodeo_event_id, status
  `;
  return row ?? null;
}

// ===========================================================================
// Payouts
// ===========================================================================

export interface PayoutContext {
  config: PayoutConfig;
  scoring_mode: ScoringMode;
  entries: Entryish[];
  results: Rankable[];
  results_by_round: Map<number, Rankable[]>;
  average_results: Rankable[];
  added_money_cents: number;
  entry_fee_cents: number;
  num_go_rounds: number;
}

const toCents = (v: string | number | null): number =>
  Math.round(Number(v ?? 0) * 100);

/**
 * Everything the payout engine needs for one event, in four queries.
 *
 * Money is stored as DECIMAL and converted to integer cents on the way in, so
 * the engine never sees a float dollar amount. That conversion happening in
 * exactly one place is why the reconciliation guarantee holds.
 */
export async function loadPayoutContext(
  tx: Tx,
  orgId: string,
  eventId: string,
  configId?: string,
): Promise<PayoutContext | null> {
  const [event] = await tx<
    {
      scoring_mode: ScoringMode;
      entry_fee: string;
      added_money: string;
      num_go_rounds: number;
      payout_config_id: string | null;
    }[]
  >`
    select scoring_mode, entry_fee, added_money, num_go_rounds, payout_config_id
      from rodeo_events
     where id = ${eventId} and org_id = ${orgId}
  `;
  if (!event) return null;

  const resolvedConfigId = configId ?? event.payout_config_id;
  if (!resolvedConfigId) return null;

  const [cfg] = await tx<{ config: PayoutConfig }[]>`
    select config from payout_configs where id = ${resolvedConfigId}
  `;
  if (!cfg) return null;

  const entryRows = await tx<
    { contestant_id: string; status: string; entry_fee_amount: string | null }[]
  >`
    select contestant_id, status, entry_fee_amount
      from entries
     where rodeo_event_id = ${eventId} and org_id = ${orgId}
  `;

  // A team roping run is ONE entry with a partner on it, and it places once.
  // Joining the entry in is what lets the payout engine pay both ends: without
  // partner_id the heeler is invisible and only the header gets a cheque.
  const scoreRows = await tx<
    {
      entry_id: string;
      contestant_id: string;
      partner_id: string | null;
      status: string;
      go_round: number;
      final_score: string | null;
      final_time: string | null;
    }[]
  >`
    select s.entry_id, s.contestant_id, e.partner_id, s.status, s.go_round,
           s.final_score, s.final_time
      from scores s
      join entries e on e.id = s.entry_id
     where s.rodeo_event_id = ${eventId}
       and s.org_id = ${orgId}
       and s.status in ('official', 'no_time', 'dq')
     order by s.go_round
  `;

  const judged = event.scoring_mode === 'judged';
  const isTeamEvent = (cfg.config as PayoutConfig).team_payout !== undefined;

  const toRankable = (r: (typeof scoreRows)[number]): Rankable => ({
    // A team is ranked by its ENTRY, not by one of its members: the same
    // header can be on three teams in the same roping, and each run places
    // separately.
    contestant_id: isTeamEvent ? r.entry_id : r.contestant_id,
    status: r.status as Rankable['status'],
    final_score: judged && r.final_score !== null ? Number(r.final_score) : null,
    final_time: !judged && r.final_time !== null ? Number(r.final_time) : null,
    ...(isTeamEvent
      ? {
          team_members: r.partner_id
            ? [r.contestant_id, r.partner_id]
            : [r.contestant_id],
        }
      : {}),
  });

  const byRound = new Map<number, Rankable[]>();
  for (const row of scoreRows) {
    const bucket = byRound.get(row.go_round) ?? [];
    bucket.push(toRankable(row));
    byRound.set(row.go_round, bucket);
  }

  // The average is computed in the engine, not here — a contestant needs a
  // qualified run in every round, and that rule lives in one place.
  const averageRows = await tx<
    { contestant_id: string; aggregate_score: string | null }[]
  >`
    select contestant_id, aggregate_score
      from results
     where rodeo_event_id = ${eventId}
       and org_id = ${orgId}
       and result_type = 'average'
  `;

  return {
    config: cfg.config,
    scoring_mode: event.scoring_mode,
    num_go_rounds: event.num_go_rounds,
    added_money_cents: toCents(event.added_money),
    entry_fee_cents: toCents(event.entry_fee),
    entries: entryRows.map((e) => ({
      contestant_id: e.contestant_id,
      status: e.status,
      entry_fee_cents:
        e.entry_fee_amount !== null ? toCents(e.entry_fee_amount) : undefined,
    })),
    results: (byRound.get(1) ?? []).slice(),
    results_by_round: byRound,
    average_results: averageRows.map((a) => ({
      contestant_id: a.contestant_id,
      status: 'official' as const,
      final_score: judged ? Number(a.aggregate_score ?? 0) : null,
      final_time: judged ? null : Number(a.aggregate_score ?? 0),
    })),
  };
}

export interface DisburseLine {
  contestant_id: string | null;
  amount_cents: number;
  type: string;
  place?: number;
  go_round?: number;
  d_division?: number;
}

export interface DisburseResult {
  transactions_written: number;
  total_cents: number;
  already_disbursed: boolean;
  idempotency_key: string;
}

const LEDGER_TYPE: Record<string, string> = {
  prize: 'payout_prize',
  go_round: 'payout_prize',
  average: 'payout_prize',
  d_division: 'payout_prize',
  day_money: 'payout_day_money',
  stock_contractor: 'payout_stock_contractor',
  pesi_offspring: 'payout_bonus',
  pesi_stallion: 'payout_bonus',
};

/**
 * Write payout lines to the ledger.
 *
 * Idempotent by construction. Every row carries a key derived from the caller's
 * key plus the line's identity, and `idx_txn_idempotency` is a unique index —
 * so a retry after a network timeout conflicts instead of paying twice. The
 * whole batch is one transaction: either every line lands or none does.
 *
 * The ledger row is written first and the Stripe transfer follows, keyed to
 * the same idempotency key. Recording the intent before moving the money means
 * a crash between the two leaves a pending row to reconcile, rather than money
 * gone with no record of why.
 */
export async function disburse(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  idempotencyKey: string,
  actorId: string,
  lines: DisburseLine[],
): Promise<DisburseResult> {
  const existing = await tx<{ n: string }[]>`
    select count(*) as n
      from financial_transactions
     where org_id = ${orgId}
       and idempotency_key like ${idempotencyKey + ':%'}
  `;

  if (Number(existing[0]?.n ?? 0) > 0) {
    const [sum] = await tx<{ total: string | null; n: string }[]>`
      select sum(amount) as total, count(*) as n
        from financial_transactions
       where org_id = ${orgId}
         and idempotency_key like ${idempotencyKey + ':%'}
    `;
    return {
      transactions_written: Number(sum?.n ?? 0),
      total_cents: toCents(sum?.total ?? 0),
      already_disbursed: true,
      idempotency_key: idempotencyKey,
    };
  }

  let written = 0;
  let total = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.amount_cents <= 0 || !line.contestant_id) continue;

    const lineKey = `${idempotencyKey}:${line.type}:${line.go_round ?? 'x'}:${line.d_division ?? 'x'}:${line.contestant_id}:${i}`;

    const [row] = await tx<{ id: string }[]>`
      insert into financial_transactions (
        org_id, rodeo_id, to_user_id, transaction_type, amount,
        status, description, idempotency_key, metadata
      ) values (
        ${orgId}, ${rodeoId}, ${line.contestant_id},
        ${LEDGER_TYPE[line.type] ?? 'payout_prize'},
        ${(line.amount_cents / 100).toFixed(2)},
        'pending',
        ${`${line.type}${line.place ? ` — ${line.place} place` : ''}`},
        ${lineKey},
        ${tx.json({
          place: line.place ?? null,
          go_round: line.go_round ?? null,
          d_division: line.d_division ?? null,
          disbursed_by: actorId,
        } as Json)}
      )
      returning id
    `;

    await tx`
      insert into transaction_status_events
        (org_id, transaction_id, from_status, to_status, reason, actor_id)
      values
        (${orgId}, ${row.id}, null, 'pending', 'payout batch created', ${actorId})
    `;

    written++;
    total += line.amount_cents;
  }

  return {
    transactions_written: written,
    total_cents: total,
    already_disbursed: false,
    idempotency_key: idempotencyKey,
  };
}

// ===========================================================================
// Sync
// ===========================================================================

export interface ServerState {
  version?: number;
  updated_at?: string;
  source?: string;
  [key: string]: unknown;
}

export async function loadServerState(
  tx: Tx,
  orgId: string,
  change: { entity_type: string; id: string; data: Record<string, unknown> },
): Promise<ServerState | null> {
  if (change.entity_type === 'score') {
    const entryId = change.data.entry_id as string | undefined;
    const goRound = (change.data.go_round as number | undefined) ?? 1;
    if (!entryId) return null;

    const [row] = await tx<
      {
        id: string;
        source: string;
        status: string;
        updated_at: string;
        final_time: string | null;
        final_score: string | null;
        version: number;
      }[]
    >`
      select id, source, status, updated_at, final_time, final_score,
             jsonb_array_length(edit_history) as version
        from scores
       where org_id = ${orgId}
         and entry_id = ${entryId}
         and go_round = ${goRound}
         and status in ('provisional', 'official')
       limit 1
    `;
    return row ?? null;
  }

  if (change.entity_type === 'entry') {
    const [row] = await tx<{ id: string; status: string; updated_at: string }[]>`
      select id, status, updated_at
        from entries
       where org_id = ${orgId} and id = ${change.id}
    `;
    return row ?? null;
  }

  return null;
}

export async function applyChange(
  tx: Tx,
  orgId: string,
  change: {
    id: string;
    entity_type: string;
    action: string;
    data: Record<string, unknown>;
  },
  actorId: string,
): Promise<void> {
  if (change.entity_type !== 'score') return;

  const d = change.data;

  if (change.action === 'create') {
    await tx`
      insert into scores (
        id, org_id, rodeo_id, rodeo_event_id, entry_id, contestant_id,
        go_round, raw_time, final_time, final_score, status, source, entered_by
      ) values (
        ${change.id}, ${orgId}, ${d.rodeo_id as string},
        ${d.rodeo_event_id as string}, ${d.entry_id as string},
        ${d.contestant_id as string}, ${(d.go_round as number) ?? 1},
        ${(d.raw_time as number) ?? null}, ${(d.final_time as number) ?? null},
        ${(d.final_score as number) ?? null},
        ${(d.status as string) ?? 'provisional'},
        ${(d.source as string) ?? 'manual'}, ${actorId}
      )
      on conflict (id) do nothing
    `;
    return;
  }

  await tx`
    update scores
       set final_time  = coalesce(${(d.final_time as number) ?? null}, final_time),
           final_score = coalesce(${(d.final_score as number) ?? null}, final_score),
           status      = coalesce(${(d.status as string) ?? null}, status),
           source      = coalesce(${(d.source as string) ?? null}, source),
           last_edited_by = ${actorId}
     where org_id = ${orgId}
       and entry_id = ${d.entry_id as string}
       and go_round = ${(d.go_round as number) ?? 1}
       and status in ('provisional', 'official')
  `;
}

export async function changesSince(
  tx: Tx,
  orgId: string,
  since: string,
): Promise<
  {
    entity_type: 'score';
    entity_id: string;
    data: Record<string, unknown>;
    updated_at: string;
  }[]
> {
  const rows = await tx<
    {
      entity_id: string;
      rodeo_event_id: string;
      entry_id: string;
      contestant_id: string;
      go_round: number;
      final_time: string | null;
      final_score: string | null;
      status: string;
      source: string;
      updated_at: string;
    }[]
  >`
    select id as entity_id, rodeo_event_id, entry_id, contestant_id, go_round,
           final_time, final_score, status, source, updated_at
      from scores
     where org_id = ${orgId}
       and updated_at > ${since}::timestamptz
     order by updated_at
     limit 1000
  `;

  return rows.map((r) => ({
    entity_type: 'score' as const,
    entity_id: r.entity_id,
    updated_at: r.updated_at,
    data: {
      rodeo_event_id: r.rodeo_event_id,
      entry_id: r.entry_id,
      contestant_id: r.contestant_id,
      go_round: r.go_round,
      final_time: r.final_time === null ? null : Number(r.final_time),
      final_score: r.final_score === null ? null : Number(r.final_score),
      status: r.status,
      source: r.source,
    },
  }));
}

// ===========================================================================
// Public
// ===========================================================================

export async function loadPublicResults(tx: Tx, rodeoId: string): Promise<unknown> {
  // Reads the public_results view, not `results` joined to `users`. A public
  // scoreboard needs a name; it must not be able to reach a contestant's
  // email, phone, date of birth, address or tax identifiers. The view is the
  // single place a name crosses that boundary. See migration 0016 / D31.
  const rows = await tx<
    {
      rodeo_name: string;
      start_date: string;
      end_date: string;
      venue_city: string | null;
      venue_state: string | null;
      event_type: string;
      result_type: string;
      go_round: number | null;
      d_division: number | null;
      place: number;
      first_name: string;
      last_name: string;
      aggregate_score: string | null;
      payout_amount: string;
    }[]
  >`
    select rodeo_name, start_date, end_date, venue_city, venue_state,
           event_type, result_type, go_round, d_division, place,
           first_name, last_name, aggregate_score, payout_amount
      from public_results
     where rodeo_id = ${rodeoId}
     order by event_sort_order, event_type, result_type, go_round, place
  `;

  if (rows.length === 0) return null;

  type Placing = (typeof rows)[number];
  const byEvent = new Map<string, Placing[]>();
  for (const row of rows) {
    const bucket = byEvent.get(row.event_type) ?? [];
    bucket.push(row);
    byEvent.set(row.event_type, bucket);
  }

  const first = rows[0];
  return {
    rodeo: {
      id: rodeoId,
      name: first.rodeo_name,
      start_date: first.start_date,
      end_date: first.end_date,
      venue_city: first.venue_city,
      venue_state: first.venue_state,
    },
    events: [...byEvent.entries()].map(([event_type, placings]) => ({
      event_type,
      placings: placings.map((p) => ({
        place: p.place,
        contestant: `${p.first_name} ${p.last_name}`,
        result_type: p.result_type,
        go_round: p.go_round,
        d_division: p.d_division,
        score: p.aggregate_score === null ? null : Number(p.aggregate_score),
        payout: Number(p.payout_amount),
      })),
    })),
  };
}

export async function loadStandings(
  tx: Tx,
  body: string,
  season: string,
  eventType: string,
): Promise<unknown> {
  // Same boundary as loadPublicResults: aggregated over public_standings, so
  // there is exactly one surface where a contestant name leaves the private
  // tables.
  const rows = await tx<
    {
      contestant_id: string;
      first_name: string;
      last_name: string;
      total_points: string;
      total_earnings: string;
      rodeos_entered: string;
    }[]
  >`
    select contestant_id, first_name, last_name,
           total_points, total_earnings, rodeos_entered
      from public_standings
     where sanctioning_body = ${body}
       and season = ${season}
       and event_type = ${eventType}
     order by total_points desc, total_earnings desc
     limit 200
  `;

  return {
    sanctioning_body: body,
    season,
    event_type: eventType,
    standings: rows.map((r, i) => ({
      rank: i + 1,
      contestant_id: r.contestant_id,
      name: `${r.first_name} ${r.last_name}`,
      points: Number(r.total_points),
      earnings: Number(r.total_earnings),
      rodeos_entered: Number(r.rodeos_entered),
    })),
  };
}

/**
 * Correct a score that is already official.
 *
 * The arena reverses a call more often than any software design admits: a
 * judge's sheet turns up with 17.24 where the terminal has 17.42, a barrier
 * flag was missed, a time was read off the wrong lane. So correcting is a
 * first-class operation, not an admin escape hatch.
 *
 * Nothing here writes edit_history. The `scores_record_edits` trigger appends
 * to it on every UPDATE, so the record is kept even when a change is made by
 * bypassing this function entirely — which is the only way that guarantee is
 * worth anything.
 */
export async function correctScore(
  tx: Tx,
  orgId: string,
  scoreId: string,
  actorId: string,
  patch: {
    final_time?: number | null;
    final_score?: number | null;
    raw_time?: number | null;
    time_penalties?: unknown;
    judge_scores?: unknown;
    reason: string;
  },
): Promise<{ id: string; rodeo_event_id: string; status: string } | null> {
  const [row] = await tx<{ id: string; rodeo_event_id: string; status: string }[]>`
    update scores
       set final_time     = ${patch.final_time ?? null},
           final_score    = ${patch.final_score ?? null},
           raw_time       = coalesce(${patch.raw_time ?? null}, raw_time),
           time_penalties = coalesce(
             ${patch.time_penalties ? tx.json(patch.time_penalties as Json) : null},
             time_penalties),
           judge_scores   = coalesce(
             ${patch.judge_scores ? tx.json(patch.judge_scores as Json) : null},
             judge_scores),
           correction_reason = ${patch.reason},
           last_edited_by = ${actorId},
           updated_at     = now()
     where id = ${scoreId}
       and org_id = ${orgId}
       and status in ('provisional', 'official')
    returning id, rodeo_event_id, status
  `;
  return row ?? null;
}

/** Disqualify a run. The reason is not optional — the schema refuses without one. */
export async function disqualifyScore(
  tx: Tx,
  orgId: string,
  scoreId: string,
  actorId: string,
  reason: string,
): Promise<{ id: string; rodeo_event_id: string; status: string } | null> {
  const [row] = await tx<{ id: string; rodeo_event_id: string; status: string }[]>`
    update scores
       set status = 'dq',
           dq_reason = ${reason},
           -- A DQ has no placing time or score. Leaving the old value would
           -- put a disqualified run back in the ranking the moment somebody
           -- re-finalised the event.
           final_time = null,
           final_score = null,
           last_edited_by = ${actorId},
           updated_at = now()
     where id = ${scoreId}
       and org_id = ${orgId}
       and status in ('provisional', 'official')
    returning id, rodeo_event_id, status
  `;
  return row ?? null;
}

/**
 * Award a re-ride.
 *
 * Marks the original 'reride', which frees the one-live-score-per-entry slot
 * (`idx_scores_one_live_per_entry`) so the replacement run can be scored
 * normally. The original is never deleted — it is the evidence that a re-ride
 * was given and why.
 */
export async function markReride(
  tx: Tx,
  orgId: string,
  scoreId: string,
  actorId: string,
  reason: string,
): Promise<{ id: string; rodeo_event_id: string; entry_id: string } | null> {
  const [row] = await tx<
    { id: string; rodeo_event_id: string; entry_id: string }[]
  >`
    update scores
       set status = 'reride',
           reride_reason = ${reason},
           last_edited_by = ${actorId},
           updated_at = now()
     where id = ${scoreId}
       and org_id = ${orgId}
       and status in ('provisional', 'official')
    returning id, rodeo_event_id, entry_id
  `;
  return row ?? null;
}

/** Every run in an event, with its edit history, for the correction screen. */
export async function loadScoreSheet(
  tx: Tx,
  orgId: string,
  eventId: string,
): Promise<
  {
    score_id: string;
    entry_id: string;
    contestant_id: string;
    contestant_name: string;
    go_round: number;
    final_time: string | null;
    final_score: string | null;
    status: string;
    dq_reason: string | null;
    reride_reason: string | null;
    correction_reason: string | null;
    edit_history: unknown;
  }[]
> {
  return tx`
    select s.id as score_id, s.entry_id, s.contestant_id,
           trim(u.first_name || ' ' || u.last_name) as contestant_name,
           s.go_round,
           s.final_time::text as final_time,
           s.final_score::text as final_score,
           s.status, s.dq_reason, s.reride_reason, s.correction_reason,
           s.edit_history
      from scores s
      join users u on u.id = s.contestant_id
     where s.org_id = ${orgId} and s.rodeo_event_id = ${eventId}
     order by s.go_round, u.last_name, u.first_name, s.created_at
  `;
}
