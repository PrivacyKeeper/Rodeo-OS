/**
 * The sanction layer — associations, the compliance calendar, and who is
 * carded to work the rodeo.
 *
 * ---------------------------------------------------------------------------
 * A JACKPOT MUST NEVER SEE ANY OF THIS.
 * ---------------------------------------------------------------------------
 * Every route here is scoped to a rodeo's approved sanctioning bodies. A rodeo
 * with none — which is most rodeos in this country — gets an empty checklist
 * and an empty shortfall, and the interface hides the whole section. If a
 * Tuesday-night roping is ever asked about a livestock-welfare form, this
 * layer has failed and the fix is here, not in the UI.
 */

import type { FastifyPluginAsync } from 'fastify';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as ops from '../../core/database/operations-repo.ts';

export const registerSanctionModule: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /associations
   *
   * The sanctioning-body dropdown, with the rules behind each one. Carries
   * `is_verified` and `verified_against` on every row: a profile whose filing
   * deadline came from a secondary source has to say so on screen, not just in
   * a migration comment.
   */
  fastify.get<{ Params: { org_id: string } }>(
    '/associations',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.loadAssociations(tx, request.params.org_id),
      );
      reply.header('cache-control', 'private, max-age=300');
      return reply.send({
        data: rows,
        meta: {
          request_id: request.id,
          unverified: rows.filter((r) => !r.is_verified).length,
        },
      });
    },
  );

  /** GET /associations/:association_id/requirements */
  fastify.get<{ Params: { org_id: string; association_id: string } }>(
    '/associations/:association_id/requirements',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.loadAssociationRequirements(tx, request.params.association_id),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  /** GET /rodeos/:rodeo_id/compliance */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/compliance',
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;
      const items = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.loadCompliance(tx, org_id, rodeo_id),
      );
      const outstanding = items.filter(
        (i) => i.status !== 'satisfied' && i.status !== 'waived',
      );
      return reply.send({
        data: items,
        meta: {
          request_id: request.id,
          outstanding: outstanding.length,
          blocking: outstanding.filter((i) => i.blocks_close).length,
        },
      });
    },
  );

  /**
   * POST /rodeos/:rodeo_id/compliance/generate
   *
   * Idempotent. Run again when a committee adds a second sanctioning body in
   * March, which is the normal case.
   */
  fastify.post<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/compliance/generate',
    { preHandler: requirePermission('compliance.manage') },
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;
      const out = await fastify.db.asUser(claimsFor(request.auth!), async (tx) => {
        const created = await ops.generateCompliance(tx, org_id, rodeo_id);
        const items = await ops.loadCompliance(tx, org_id, rodeo_id);
        return { created, items };
      });
      return reply.send({
        data: out.items,
        meta: { request_id: request.id, created: out.created },
      });
    },
  );

  /** PATCH /rodeos/:rodeo_id/compliance/:item_id */
  fastify.patch<{
    Params: { org_id: string; rodeo_id: string; item_id: string };
    Body: {
      status?: string;
      evidence_url?: string;
      amount_cents?: number;
      waived_reason?: string;
      notes?: string;
    };
  }>(
    '/rodeos/:rodeo_id/compliance/:item_id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'satisfied', 'waived', 'failed'],
            },
            evidence_url: { type: 'string', maxLength: 2000 },
            amount_cents: { type: 'integer', minimum: 0 },
            waived_reason: { type: 'string', minLength: 4, maxLength: 500 },
            notes: { type: 'string', maxLength: 2000 },
          },
        },
      },
      preHandler: requirePermission('compliance.manage'),
    },
    async (request, reply) => {
      const { org_id, item_id } = request.params;

      // Waiving is a decision somebody made, and the record has to say who and
      // why. The database enforces the reason too; this is the friendlier error.
      if (request.body.status === 'waived' && !request.body.waived_reason) {
        return reply.status(400).send({
          error: {
            code: 'WAIVER_NEEDS_REASON',
            message: 'Waiving a requirement needs a reason on the record.',
          },
          meta: { request_id: request.id },
        });
      }

      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.updateComplianceItem(tx, org_id, item_id, {
          ...request.body,
          actor_id: request.auth!.user.user_id,
        }),
      );

      if (!row) {
        return reply.status(404).send({
          error: { code: 'ITEM_NOT_FOUND', message: 'No such compliance item.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: row, meta: { request_id: request.id } });
    },
  );
};
