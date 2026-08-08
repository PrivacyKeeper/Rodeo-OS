/**
 * The entry desk.
 *
 * People, entries, back numbers and sidepots — the four things between "a
 * rodeo exists" and "there is a draw to score". Everything here already had an
 * engine or a table behind it; what was missing was the surface a secretary
 * with a queue in front of her can actually reach.
 */

import type { FastifyPluginAsync } from 'fastify';

import {
  calculatePayout,
  formatCents,
  type Entryish,
  type PayoutConfig,
  type Rankable,
} from '@rodeo-os/engine';

import { isUuid, requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as desk from '../../core/database/desk-repo.ts';

export const registerDeskModule: FastifyPluginAsync = async (fastify) => {
  // =======================================================================
  // People
  // =======================================================================

  /**
   * GET /people?q=rop
   *
   * Global search over `users`, narrow result. See the note in desk-repo:
   * searching only this org's contestants would guarantee a duplicate for
   * every roper who has competed anywhere else, and the duplicate is what
   * destroys the career record.
   */
  fastify.get<{ Params: { org_id: string }; Querystring: { q: string; limit?: number } }>(
    '/people',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          additionalProperties: false,
          properties: {
            q: { type: 'string', minLength: 2, maxLength: 80 },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
        },
      },
      preHandler: requirePermission('entry.manage'),
    },
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        desk.searchPeople(tx, request.params.org_id, request.query.q, request.query.limit ?? 20),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  /** POST /people — a contestant who has never signed in. */
  fastify.post<{ Params: { org_id: string }; Body: desk.NewPerson }>(
    '/people',
    {
      schema: {
        body: {
          type: 'object',
          required: ['first_name', 'last_name'],
          additionalProperties: false,
          properties: {
            first_name: { type: 'string', minLength: 1, maxLength: 80 },
            last_name: { type: 'string', minLength: 1, maxLength: 80 },
            email: { type: 'string', format: 'email', maxLength: 200 },
            phone: { type: 'string', maxLength: 32 },
            date_of_birth: { type: 'string', format: 'date' },
            city: { type: 'string', maxLength: 120 },
            state_province: { type: 'string', maxLength: 60 },
            memberships: { type: 'array', maxItems: 20, items: { type: 'object' } },
          },
        },
      },
      preHandler: requirePermission('entry.manage'),
    },
    async (request, reply) => {
      try {
        const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
          desk.createPerson(tx, request.body),
        );
        return reply.status(201).send({ data: row, meta: { request_id: request.id } });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.status(409).send({
            error: {
              code: 'EMAIL_TAKEN',
              message: 'Somebody already has that email. Search for them instead.',
            },
            meta: { request_id: request.id },
          });
        }
        throw err;
      }
    },
  );

  /**
   * POST /people/merge
   *
   * Two records, one person. Every duplicate splits a career record in half,
   * so this is a maintenance tool the desk needs, not an admin curiosity.
   * Narrower permission than entry management: it rewrites history.
   */
  fastify.post<{
    Params: { org_id: string };
    Body: { keep_id: string; merge_id: string; reason: string };
  }>(
    '/people/merge',
    {
      schema: {
        body: {
          type: 'object',
          required: ['keep_id', 'merge_id', 'reason'],
          additionalProperties: false,
          properties: {
            keep_id: { type: 'string', format: 'uuid' },
            merge_id: { type: 'string', format: 'uuid' },
            reason: { type: 'string', minLength: 4, maxLength: 500 },
          },
        },
      },
      preHandler: requirePermission('rodeo.publish'),
    },
    async (request, reply) => {
      const { keep_id, merge_id, reason } = request.body;
      if (keep_id === merge_id) {
        return reply.status(400).send({
          error: { code: 'SAME_PERSON', message: 'Those are the same record.' },
          meta: { request_id: request.id },
        });
      }
      const out = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        desk.mergePeople(tx, keep_id, merge_id, request.auth!.user.user_id, reason),
      );
      return reply.send({ data: out, meta: { request_id: request.id } });
    },
  );

  // =======================================================================
  // Entries
  // =======================================================================

  /** GET /rodeos/:rodeo_id/entries?event_id=... — the books. */
  fastify.get<{
    Params: { org_id: string; rodeo_id: string };
    Querystring: { event_id?: string };
  }>(
    '/rodeos/:rodeo_id/entries',
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;
      const eventId = request.query.event_id ?? null;
      if (eventId && !isUuid(eventId)) {
        return reply.status(400).send({
          error: { code: 'BAD_ID', message: 'event_id must be a uuid.' },
          meta: { request_id: request.id },
        });
      }
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        desk.listEntries(tx, org_id, rodeo_id, eventId),
      );
      return reply.send({
        data: rows,
        meta: {
          request_id: request.id,
          live: rows.filter((r) => !['scratched', 'turned_out', 'no_show'].includes(r.status))
            .length,
          unpaid: rows.filter((r) => !r.fees_paid).length,
        },
      });
    },
  );

  /** PATCH /rodeos/:rodeo_id/entries/:entry_id — the note and the money. */
  fastify.patch<{
    Params: { org_id: string; rodeo_id: string; entry_id: string };
    Body: { notes?: string | null; fees_paid?: boolean };
  }>(
    '/rodeos/:rodeo_id/entries/:entry_id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            notes: { type: ['string', 'null'], maxLength: 2000 },
            fees_paid: { type: 'boolean' },
          },
        },
      },
      preHandler: requirePermission('entry.manage'),
    },
    async (request, reply) => {
      const { org_id, entry_id } = request.params;
      const found = await fastify.db.asUser(claimsFor(request.auth!), async (tx) => {
        let ok = true;
        if (request.body.notes !== undefined) {
          ok = await desk.setEntryNote(tx, org_id, entry_id, request.body.notes);
        }
        if (request.body.fees_paid !== undefined) {
          ok = (await desk.markEntryPaid(tx, org_id, entry_id, request.body.fees_paid)) && ok;
        }
        return ok;
      });
      if (!found) {
        return reply.status(404).send({
          error: { code: 'ENTRY_NOT_FOUND', message: 'No such entry.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: { updated: true }, meta: { request_id: request.id } });
    },
  );

  // =======================================================================
  // Back numbers
  // =======================================================================

  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/back-numbers',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        desk.listBackNumbers(tx, request.params.org_id, request.params.rodeo_id),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  /**
   * POST /rodeos/:rodeo_id/back-numbers/assign
   *
   * Hands one to everybody who has not got one, in surname order. Re-running
   * it after late entries continues the series — it never reshuffles a number
   * that is already written on somebody's shirt.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: { start?: number };
  }>(
    '/rodeos/:rodeo_id/back-numbers/assign',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { start: { type: 'integer', minimum: 1, maximum: 99999 } },
        },
      },
      preHandler: requirePermission('entry.manage'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;
      const out = await fastify.db.asUser(claimsFor(request.auth!), async (tx) => {
        const issued = await desk.assignBackNumbers(tx, org_id, rodeo_id, request.body?.start ?? 1);
        const rows = await desk.listBackNumbers(tx, org_id, rodeo_id);
        return { issued, rows };
      });
      return reply.send({
        data: out.rows,
        meta: { request_id: request.id, issued: out.issued },
      });
    },
  );

  /** PUT /rodeos/:rodeo_id/back-numbers/:contestant_id — set one by hand. */
  fastify.put<{
    Params: { org_id: string; rodeo_id: string; contestant_id: string };
    Body: { back_number: string };
  }>(
    '/rodeos/:rodeo_id/back-numbers/:contestant_id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['back_number'],
          additionalProperties: false,
          // Text, not an integer: '7A' and '2-B' are real back numbers.
          properties: { back_number: { type: 'string', minLength: 1, maxLength: 12 } },
        },
      },
      preHandler: requirePermission('entry.manage'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id, contestant_id } = request.params;
      try {
        const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
          desk.setBackNumber(tx, org_id, rodeo_id, contestant_id, request.body.back_number.trim()),
        );
        return reply.send({ data: row, meta: { request_id: request.id } });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.status(409).send({
            error: {
              code: 'NUMBER_TAKEN',
              message: `${request.body.back_number} is already on somebody else at this rodeo.`,
            },
            meta: { request_id: request.id },
          });
        }
        throw err;
      }
    },
  );

  // =======================================================================
  // Sidepots
  // =======================================================================

  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/sidepots',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        desk.listSidepots(tx, request.params.org_id, request.params.rodeo_id),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  fastify.post<{ Params: { org_id: string; rodeo_id: string }; Body: desk.NewSidepot }>(
    '/rodeos/:rodeo_id/sidepots',
    {
      schema: {
        body: {
          type: 'object',
          required: ['rodeo_event_id', 'name', 'buy_in_cents'],
          additionalProperties: false,
          properties: {
            rodeo_event_id: { type: 'string', format: 'uuid' },
            name: { type: 'string', minLength: 1, maxLength: 80 },
            sidepot_type: {
              type: 'string',
              enum: ['sidepot', 'incentive', 'option', 'rookie', 'senior', 'youth', 'novice', 'jackpot'],
            },
            buy_in_cents: { type: 'integer', minimum: 0, maximum: 10_000_00 },
            added_money_cents: { type: 'integer', minimum: 0, maximum: 100_000_00 },
            go_round: { type: ['integer', 'null'], minimum: 1, maximum: 20 },
            payout_config_id: { type: 'string', format: 'uuid' },
            eligibility: { type: 'object' },
          },
        },
      },
      preHandler: requirePermission('rodeo.edit'),
    },
    async (request, reply) => {
      try {
        const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
          desk.createSidepot(tx, request.params.org_id, request.params.rodeo_id, request.body),
        );
        return reply.status(201).send({ data: row, meta: { request_id: request.id } });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.status(409).send({
            error: {
              code: 'SIDEPOT_EXISTS',
              message: 'That event already has a sidepot with that name.',
            },
            meta: { request_id: request.id },
          });
        }
        throw err;
      }
    },
  );

  /**
   * POST /rodeos/:rodeo_id/sidepots/:sidepot_id/calculate
   *
   * A sidepot is a purse like any other, so it goes through the same payout
   * engine as the event — the same ladder selection, the same tie handling,
   * the same largest-remainder allocation. The only thing that differs is
   * where the money came from.
   *
   * Only PAID buy-ins count. Somebody who said they were in and never handed
   * over the money is not in the pot, or the pot does not reconcile.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; sidepot_id: string };
    Body: { commit?: boolean };
  }>(
    '/rodeos/:rodeo_id/sidepots/:sidepot_id/calculate',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { commit: { type: 'boolean', default: false } },
        },
      },
      preHandler: requirePermission('payout.calculate'),
    },
    async (request, reply) => {
      const { org_id, sidepot_id } = request.params;

      const loaded = await fastify.db.asUser(claimsFor(request.auth!), async (tx) => {
        const { sidepot, standings } = await desk.loadSidepotStandings(tx, org_id, sidepot_id);
        if (!sidepot) return null;
        const config = await desk.loadSidepotPayoutConfig(tx, org_id, sidepot_id);
        return { sidepot, standings, config };
      });

      if (!loaded) {
        return reply.status(404).send({
          error: { code: 'SIDEPOT_NOT_FOUND', message: 'No such sidepot.' },
          meta: { request_id: request.id },
        });
      }

      const { sidepot, standings, config } = loaded;
      const paid = standings.filter((s) => s.paid);

      if (!config) {
        return reply.status(409).send({
          error: {
            code: 'NO_PAYOUT_CONFIG',
            message: 'This sidepot has no payout ladder. Set one before calculating.',
          },
          meta: { request_id: request.id },
        });
      }

      const mode = sidepot.scoring_mode === 'timed' ? 'timed' : 'judged';

      const rankable: Rankable[] = paid
        .filter((s) => s.score_status === 'official' || s.score_status === 'provisional')
        .map((s) => ({
          entry_id: s.entry_id,
          contestant_id: s.contestant_id,
          final_time: s.final_time === null ? null : Number(s.final_time),
          final_score: s.final_score === null ? null : Number(s.final_score),
          status: s.score_status === 'official' ? 'official' : 'provisional',
        })) as unknown as Rankable[];

      // Every PAID buy-in is an entry in the pot, whether or not they got a
      // qualified run — that is what funds it, and ground money depends on the
      // difference between who paid and who placed.
      const entries: Entryish[] = paid.map((s) => ({
        entry_id: s.entry_id,
        contestant_id: s.contestant_id,
        status: 'competed',
        entry_fee_cents: sidepot.buy_in_cents,
      })) as unknown as Entryish[];

      const payout = calculatePayout({
        payout_config: config as unknown as PayoutConfig,
        scoring_mode: mode,
        entries,
        added_money_cents: sidepot.added_money_cents,
        entry_fee_cents: sidepot.buy_in_cents,
        // Raw, not ranked: calculatePayout ranks internally, so ranking here
        // would hand it a placed list and lose the tie information.
        results: rankable,
      });

      if (!payout.ok) {
        return reply.status(422).send({
          error: {
            code: 'SIDEPOT_CALCULATION_FAILED',
            message: 'The sidepot payout could not be calculated.',
            details: { issues: payout.issues },
          },
          meta: { request_id: request.id },
        });
      }

      // Same post-condition as the event payout. A pot that does not
      // reconcile is not served, whatever the caller asked for.
      const disbursed = payout.payouts.reduce((s, p) => s + p.amount_cents, 0);
      if (disbursed + payout.unpaid_cents + payout.escrow_cents !== payout.net_purse_cents) {
        request.log.error({ org_id, sidepot_id }, 'sidepot payout does not reconcile');
        return reply.status(500).send({
          error: {
            code: 'PAYOUT_DOES_NOT_RECONCILE',
            message: 'Internal sidepot reconciliation failed; nothing was written.',
          },
          meta: { request_id: request.id },
        });
      }

      const names = new Map(standings.map((s) => [s.contestant_id, s.contestant_name]));

      if (request.body?.commit) {
        await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
          desk.setSidepotStatus(tx, org_id, sidepot_id, 'calculated'),
        );
      }

      return reply.send({
        data: {
          sidepot: { id: sidepot.id, name: sidepot.name, status: sidepot.status },
          buyers: paid.length,
          unpaid_buyers: standings.length - paid.length,
          gross_purse_cents: payout.gross_purse_cents,
          net_purse_cents: payout.net_purse_cents,
          payouts: payout.payouts.map((l) => ({
            ...l,
            // A ground-money or escrow line has no contestant, by design.
            contestant_name: l.contestant_id ? names.get(l.contestant_id) ?? null : null,
            display_amount: formatCents(l.amount_cents),
          })),
          issues: payout.issues,
        },
        meta: { request_id: request.id },
      });
    },
  );

  fastify.patch<{
    Params: { org_id: string; rodeo_id: string; sidepot_id: string };
    Body: { status: string };
  }>(
    '/rodeos/:rodeo_id/sidepots/:sidepot_id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: {
            status: {
              type: 'string',
              enum: ['open', 'closed', 'calculated', 'paid', 'cancelled'],
            },
          },
        },
      },
      preHandler: requirePermission('rodeo.edit'),
    },
    async (request, reply) => {
      const ok = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        desk.setSidepotStatus(tx, request.params.org_id, request.params.sidepot_id, request.body.status),
      );
      if (!ok) {
        return reply.status(404).send({
          error: { code: 'SIDEPOT_NOT_FOUND', message: 'No such sidepot.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: { updated: true }, meta: { request_id: request.id } });
    },
  );
};
