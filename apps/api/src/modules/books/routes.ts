/**
 * Closing the books.
 *
 * ---------------------------------------------------------------------------
 * The readiness check runs in the ENGINE, from data this module loads. That is
 * deliberate: the same function runs in the secretary's browser as she works,
 * so the screen already knows whether she can file before she presses
 * anything, and there is exactly one definition of "ready" rather than two
 * that will eventually disagree.
 *
 * The server re-checks before committing anyway. A client that has been open
 * since the second performance is working from stale data, and "the browser
 * said it was fine" is not a defence when a payout does not reconcile.
 * ---------------------------------------------------------------------------
 */

import type { FastifyPluginAsync } from 'fastify';

import { checkBooks, renderBooksText } from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as ops from '../../core/database/operations-repo.ts';

export const registerBooksModule: FastifyPluginAsync = async (fastify) => {
  /** GET /rodeos/:rodeo_id/books — what is standing between here and filed. */
  fastify.get<{
    Params: { org_id: string; rodeo_id: string };
    Querystring: { format?: string };
  }>(
    '/rodeos/:rodeo_id/books',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { format: { type: 'string', enum: ['json', 'text'] } },
        },
      },
      preHandler: requirePermission('financial.view'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;
      const claims = claimsFor(request.auth!);

      const loaded = await fastify.db.asUser(claims, async (tx) => {
        const context = await ops.loadBooks(tx, org_id, rodeo_id);
        if (!context) return null;
        const state = await ops.loadBookState(tx, org_id, rodeo_id);
        return { context, state };
      });

      if (!loaded) {
        return reply.status(404).send({
          error: { code: 'RODEO_NOT_FOUND', message: 'No such rodeo.' },
          meta: { request_id: request.id },
        });
      }

      const status = checkBooks({ ...loaded.context, now_ms: Date.now() });

      if (request.query.format === 'text') {
        reply.header('content-type', 'text/plain; charset=utf-8');
        return reply.send(renderBooksText(status, loaded.context.rodeo_name));
      }

      return reply.send({
        data: {
          rodeo_name: loaded.context.rodeo_name,
          association: loaded.context.association_code,
          state: loaded.state?.state ?? 'open',
          ...status,
        },
        meta: { request_id: request.id },
      });
    },
  );

  /**
   * POST /rodeos/:rodeo_id/books/close
   *
   * Refuses while a blocker stands. `force` is not offered and will not be:
   * the blockers are money that does not reconcile, runs nobody scored and
   * scores that are still provisional. None of those is a thing to override —
   * they are the difference between a set of books and a guess.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: { acknowledge_warnings?: boolean };
  }>(
    '/rodeos/:rodeo_id/books/close',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { acknowledge_warnings: { type: 'boolean', default: true } },
        },
      },
      preHandler: requirePermission('books.close'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;
      const claims = claimsFor(request.auth!);
      const actorId = request.auth!.user.user_id ?? null;

      const out = await fastify.db.asUser(claims, async (tx) => {
        const context = await ops.loadBooks(tx, org_id, rodeo_id);
        if (!context) return { kind: 'not_found' as const };

        // Re-checked here, against data read inside this transaction. What the
        // browser believed twenty minutes ago is not evidence.
        const status = checkBooks({ ...context, now_ms: Date.now() });
        if (!status.ready) {
          return { kind: 'blocked' as const, status };
        }

        const closure = await ops.closeBooks(
          tx,
          org_id,
          rodeo_id,
          actorId,
          status.totals as unknown as Record<string, number>,
          status.warnings,
          context.association_code,
          status.deadline.due_at,
        );
        return { kind: 'closed' as const, closure, status };
      });

      if (out.kind === 'not_found') {
        return reply.status(404).send({
          error: { code: 'RODEO_NOT_FOUND', message: 'No such rodeo.' },
          meta: { request_id: request.id },
        });
      }

      if (out.kind === 'blocked') {
        return reply.status(409).send({
          error: {
            code: 'BOOKS_NOT_READY',
            message: `${out.status.blockers.length} thing(s) still to fix.`,
            details: { blockers: out.status.blockers },
          },
          meta: { request_id: request.id },
        });
      }

      return reply.status(201).send({
        data: { closure: out.closure, totals: out.status.totals },
        meta: { request_id: request.id },
      });
    },
  );

  /** POST /rodeos/:rodeo_id/books/file — the association has it. */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: { reference?: string; late?: boolean; late_fee_cents?: number };
  }>(
    '/rodeos/:rodeo_id/books/file',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reference: { type: 'string', maxLength: 120 },
            late: { type: 'boolean', default: false },
            late_fee_cents: { type: 'integer', minimum: 0 },
          },
        },
      },
      preHandler: requirePermission('books.close'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;
      const actorId = request.auth!.user.user_id ?? null;

      try {
        const closure = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
          ops.fileBooks(
            tx,
            org_id,
            rodeo_id,
            actorId,
            request.body?.reference ?? null,
            request.body?.late ?? false,
            request.body?.late_fee_cents ?? null,
          ),
        );
        return reply.status(201).send({
          data: closure,
          meta: { request_id: request.id },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P0002') {
          return reply.status(409).send({
            error: {
              code: 'BOOKS_NOT_CLOSED',
              message: 'Close the books before filing them.',
            },
            meta: { request_id: request.id },
          });
        }
        throw err;
      }
    },
  );

  /**
   * POST /rodeos/:rodeo_id/books/reopen
   *
   * A judge's sheet turns up with a time written down wrong. The earlier close
   * is not erased — a reopen appends, so the record shows a close, a filing
   * and a reversal with a reason, which is what an association needs to see.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: { reason: string };
  }>(
    '/rodeos/:rodeo_id/books/reopen',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 4, maxLength: 500 } },
        },
      },
      preHandler: requirePermission('books.reopen'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;
      const actorId = request.auth!.user.user_id ?? null;

      try {
        const closure = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
          ops.reopenBooks(tx, org_id, rodeo_id, actorId, request.body.reason),
        );
        return reply.status(201).send({
          data: closure,
          meta: { request_id: request.id },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P0002') {
          return reply.status(409).send({
            error: {
              code: 'BOOKS_NEVER_CLOSED',
              message: 'These books have never been closed.',
            },
            meta: { request_id: request.id },
          });
        }
        throw err;
      }
    },
  );
};
