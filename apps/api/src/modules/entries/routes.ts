/**
 * Entries.
 *
 * Architecture ref: §4.1 "ENTRIES".
 *
 * Two endpoints matter here. `/quote` tells a contestant exactly what they owe
 * and whether they are allowed to enter, changing nothing — an entry screen
 * calls it as the form is filled in. `POST /entries` does it again and then
 * commits, because a quote is a snapshot and the rules can have moved.
 * Re-checking on write is not redundancy; it is the difference between a
 * price and a promise.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';

import {
  checkDivisionEligibility,
  checkEntryEligibility,
  classifyTurnout,
  quoteEntryFees,
  type DivisionConfig,
} from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as entriesRepo from '../../core/database/entries-repo.ts';
import { recordEntryPayment, refundEntry } from '../../core/settlement.ts';

interface EnterBody {
  contestant_id: string;
  partner_id?: string;
  entry_slot?: number;
  division_name?: string;
  header_number?: number;
  heeler_number?: number;
  buddy_group_id?: string;
  sidepot_ids?: string[];
  payment_method?: string;
  payment_reference?: string;
  idempotency_key: string;
}

const enterSchema = {
  body: {
    type: 'object',
    required: ['contestant_id', 'idempotency_key'],
    additionalProperties: false,
    properties: {
      contestant_id: { type: 'string', format: 'uuid' },
      partner_id: { type: 'string', format: 'uuid' },
      entry_slot: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
      division_name: { type: 'string', maxLength: 40 },
      header_number: { type: 'number', minimum: 0, maximum: 20 },
      heeler_number: { type: 'number', minimum: 0, maximum: 20 },
      buddy_group_id: { type: 'string', format: 'uuid' },
      sidepot_ids: {
        type: 'array',
        maxItems: 20,
        items: { type: 'string', format: 'uuid' },
      },
      payment_method: { type: 'string', maxLength: 32, default: 'stripe_connect' },
      payment_reference: { type: 'string', maxLength: 120 },
      idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
    },
  },
} as const;

/** Money in hand at the desk settles immediately; a processor has to confirm. */
const SETTLES_IMMEDIATELY = new Set(['cash', 'check', 'money_order', 'account_credit']);

export const registerEntriesModule: FastifyPluginAsync = async (fastify) => {
  /**
   * GET .../events/:event_id/entry-quote?contestant_id=...
   *
   * Read-only. What it costs, and whether they may enter.
   */
  fastify.get<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Querystring: {
      contestant_id: string;
      partner_id?: string;
      division_name?: string;
      header_number?: string;
      heeler_number?: string;
      sidepot_ids?: string;
    };
  }>(
    '/rodeos/:rodeo_id/events/:event_id/entry-quote',
    async (request, reply) => {
      const { org_id, event_id } = request.params;
      const q = request.query;

      const claims = claimsFor(request.auth!);
      const ctx = await fastify.db.asUser(claims, (tx) =>
        entriesRepo.loadEntryContext(tx, org_id, event_id, q.contestant_id),
      );
      if (!ctx) {
        return reply.status(404).send({
          error: { code: 'EVENT_NOT_FOUND', message: 'No such event.' },
          meta: { request_id: request.id },
        });
      }

      const isStaff = request.auth!.org.role !== 'contestant';
      const eligibility = checkEntryEligibility({
        rodeo_status: ctx.rodeo_status,
        allow_online_entry: ctx.allow_online_entry,
        entered_by_staff: isStaff,
        books_open_at: ctx.books_open_at,
        books_close_at: ctx.books_close_at,
        now: new Date().toISOString(),
        existing_entries: ctx.existing_entries,
        max_entries_per_contestant: ctx.max_entries_per_contestant,
      });

      // Handicap ropings: the team has to fit the division before it can be
      // quoted a price for it.
      const divisionIssues = checkDivision(ctx, q);

      const wanted = (q.sidepot_ids ?? '').split(',').filter(Boolean);
      const quote = quoteEntryFees({
        entry_fee_cents: ctx.entry_fee_cents,
        stock_charge_cents: ctx.stock_charge_cents,
        paying_ends: q.partner_id ? 2 : 1,
        is_late: eligibility.is_late,
        sidepots: ctx.sidepots.filter((p) => wanted.includes(p.id)),
      });

      return reply.send({
        data: {
          eligible: eligibility.eligible && divisionIssues.length === 0,
          is_late: eligibility.is_late,
          quote,
          available_sidepots: ctx.sidepots,
          issues: [...eligibility.issues, ...divisionIssues, ...quote.issues],
        },
        meta: { request_id: request.id },
      });
    },
  );

  /**
   * POST .../events/:event_id/entries
   *
   * Entry, fees and sidepot buy-ins in ONE transaction. A contestant is never
   * left entered-but-unpaid or paid-but-unentered; the two facts are recorded
   * together or not at all.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Body: EnterBody;
  }>(
    '/rodeos/:rodeo_id/events/:event_id/entries',
    { schema: enterSchema },
    async (request, reply) => {
      const { org_id, rodeo_id, event_id } = request.params;
      const body = request.body;
      const claims = claimsFor(request.auth!);
      const isStaff = request.auth!.org.role !== 'contestant';

      // A contestant may only enter themselves. Staff may enter anybody in
      // their org. RLS enforces this too, but a 403 is a better answer than
      // a policy violation.
      if (!isStaff && body.contestant_id !== request.auth!.user.user_id) {
        return reply.status(403).send({
          error: {
            code: 'CANNOT_ENTER_ANOTHER',
            message: 'You may only enter yourself.',
          },
          meta: { request_id: request.id },
        });
      }

      const result = await fastify.db.asUser(claims, async (tx) => {
        const ctx = await entriesRepo.loadEntryContext(
          tx,
          org_id,
          event_id,
          body.contestant_id,
        );
        if (!ctx) return { kind: 'not_found' as const };

        const eligibility = checkEntryEligibility({
          rodeo_status: ctx.rodeo_status,
          allow_online_entry: ctx.allow_online_entry,
          entered_by_staff: isStaff,
          books_open_at: ctx.books_open_at,
          books_close_at: ctx.books_close_at,
          now: new Date().toISOString(),
          existing_entries: ctx.existing_entries,
          max_entries_per_contestant: ctx.max_entries_per_contestant,
        });

        const divisionIssues = checkDivision(ctx, {
          division_name: body.division_name,
          header_number: body.header_number?.toString(),
          heeler_number: body.heeler_number?.toString(),
          contestant_id: body.contestant_id,
          partner_id: body.partner_id,
        });

        if (!eligibility.eligible || divisionIssues.length > 0) {
          return {
            kind: 'ineligible' as const,
            issues: [...eligibility.issues, ...divisionIssues],
          };
        }

        const quote = quoteEntryFees({
          entry_fee_cents: ctx.entry_fee_cents,
          stock_charge_cents: ctx.stock_charge_cents,
          paying_ends: body.partner_id ? 2 : 1,
          is_late: eligibility.is_late,
          sidepots: ctx.sidepots.filter((p) => (body.sidepot_ids ?? []).includes(p.id)),
        });

        const entryId = randomUUID();
        await entriesRepo.createEntry(tx, {
          id: entryId,
          org_id,
          rodeo_id,
          rodeo_event_id: event_id,
          contestant_id: body.contestant_id,
          partner_id: body.partner_id,
          entry_slot: body.entry_slot ?? 1,
          entry_fee_cents: quote.to_purse_cents,
          division_name: body.division_name,
          header_number: body.header_number,
          heeler_number: body.heeler_number,
          buddy_group_id: body.buddy_group_id,
          sidepot_ids: body.sidepot_ids,
        });

        const method = body.payment_method ?? 'stripe_connect';
        const settled = SETTLES_IMMEDIATELY.has(method);

        const payment = await recordEntryPayment(tx, {
          org_id,
          rodeo_id,
          rodeo_event_id: event_id,
          entry_id: entryId,
          from_user_id: body.contestant_id,
          lines: quote.lines,
          payment_method: method,
          reference: body.payment_reference,
          settled,
          idempotency_key: body.idempotency_key,
          actor_id: request.auth!.user.user_id,
        });

        if (settled) await entriesRepo.confirmEntry(tx, org_id, entryId);

        return {
          kind: 'created' as const,
          entry_id: entryId,
          quote,
          payment,
          status: settled ? 'confirmed' : 'pending',
        };
      });

      if (result.kind === 'not_found') {
        return reply.status(404).send({
          error: { code: 'EVENT_NOT_FOUND', message: 'No such event.' },
          meta: { request_id: request.id },
        });
      }
      if (result.kind === 'ineligible') {
        return reply.status(422).send({
          error: {
            code: 'ENTRY_NOT_ALLOWED',
            message: 'This entry cannot be taken.',
            details: { issues: result.issues },
          },
          meta: { request_id: request.id },
        });
      }

      fastify.eventBus.emit('entry.created', {
        org_id,
        entry_id: result.entry_id,
        rodeo_id,
      });

      return reply.status(201).send({
        data: result,
        meta: { request_id: request.id },
      });
    },
  );

  /**
   * POST .../entries/:entry_id/turnout
   *
   * Classifies the notice, refunds if it was given in time or the release is
   * excused, and records why.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; entry_id: string };
    Body: { release_type: string; performance_at: string; notified_at?: string };
  }>(
    '/rodeos/:rodeo_id/entries/:entry_id/turnout',
    {
      schema: {
        body: {
          type: 'object',
          required: ['release_type', 'performance_at'],
          additionalProperties: false,
          properties: {
            release_type: { type: 'string', maxLength: 32 },
            performance_at: { type: 'string', format: 'date-time' },
            notified_at: { type: 'string', format: 'date-time' },
          },
        },
      },
      preHandler: requirePermission('entry.manage'),
    },
    async (request, reply) => {
      const { org_id, entry_id } = request.params;
      const notifiedAt = request.body.notified_at ?? new Date().toISOString();

      const verdict = classifyTurnout({
        notified_at: notifiedAt,
        performance_at: request.body.performance_at,
        release_type: request.body.release_type,
      });

      const out = await fastify.db.asUser(claimsFor(request.auth!), async (tx) => {
        const ok = await entriesRepo.scratchEntry(tx, {
          org_id,
          entry_id,
          status: verdict.status,
          release_type: request.body.release_type,
          notified_at: notifiedAt,
        });
        if (!ok) return null;

        const refund = verdict.refund_due
          ? await refundEntry(tx, {
              org_id,
              entry_id,
              reason: `${verdict.status}: ${request.body.release_type}`,
              actor_id: request.auth!.user.user_id,
            })
          : { refunded_cents: 0, rows: 0 };

        return { verdict, refund };
      });

      if (!out) {
        return reply.status(404).send({
          error: {
            code: 'ENTRY_NOT_TURNOUTABLE',
            message: 'No live entry with that id.',
          },
          meta: { request_id: request.id },
        });
      }

      fastify.eventBus.emit('entry.scratched', {
        org_id,
        entry_id,
        reason: request.body.release_type,
      });

      return reply.send({ data: out, meta: { request_id: request.id } });
    },
  );
};

// ---------------------------------------------------------------------------

function checkDivision(
  ctx: entriesRepo.EntryContext,
  q: {
    division_name?: string;
    header_number?: string;
    heeler_number?: string;
    contestant_id?: string;
    partner_id?: string;
  },
) {
  if (!ctx.division_config || !q.division_name) return [];

  const config = ctx.division_config as DivisionConfig;
  const division = config.divisions?.find((d) => d.name === q.division_name);
  if (!division) {
    return [
      {
        field: 'division_name',
        code: 'UNKNOWN_DIVISION',
        severity: 'error' as const,
        message: `'${q.division_name}' is not a division at this roping.`,
      },
    ];
  }

  const header = Number(q.header_number);
  const heeler = Number(q.heeler_number);
  if (!Number.isFinite(header) || !Number.isFinite(heeler)) {
    return [
      {
        field: 'header_number',
        code: 'MISSING_NUMBERS',
        severity: 'error' as const,
        message: 'A numbered roping needs both ropers’ classification numbers.',
      },
    ];
  }

  return checkDivisionEligibility(
    {
      header_id: q.contestant_id ?? 'header',
      header_number: header,
      heeler_id: q.partner_id ?? 'heeler',
      heeler_number: heeler,
    },
    division,
    config,
  ).issues;
}
