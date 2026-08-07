/**
 * The draw.
 *
 * Architecture ref: §4.1 "DRAW".
 *
 * Generating a draw is a `preview` first and a commit second, on purpose. A
 * secretary wants to look at it — check the buddy groups landed together,
 * check nobody is drawn twice — before it becomes the thing contestants are
 * told. Both use the same seed, so the previewed draw and the committed draw
 * are the same draw.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';

import {
  generateDraw,
  generateStockDraw,
  redrawStock,
  type DrawMethod,
} from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as entriesRepo from '../../core/database/entries-repo.ts';

const drawSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      // Omit and one is generated. Supplying it re-runs a previous draw
      // exactly, which is how a witnessed draw is verified after the fact.
      seed: { type: 'string', minLength: 4, maxLength: 128 },
      method: {
        type: 'string',
        enum: [
          'random',
          'random_by_division',
          'buddy_group',
          'sequential_by_entry',
          'seeded_by_standings',
          'reverse_standings',
        ],
        default: 'random',
      },
      go_round: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
      commit: { type: 'boolean', default: false },
    },
  },
} as const;

export const registerDrawModule: FastifyPluginAsync = async (fastify) => {
  /**
   * POST .../events/:event_id/draw
   *
   * `commit: false` (the default) previews. `commit: true` writes it and
   * records the seed in the audit log so the draw can be replayed.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Body: { seed?: string; method?: DrawMethod; go_round?: number; commit?: boolean };
  }>(
    '/rodeos/:rodeo_id/events/:event_id/draw',
    { schema: drawSchema, preHandler: requirePermission('draw.generate') },
    async (request, reply) => {
      const { org_id, rodeo_id, event_id } = request.params;
      const seed = request.body.seed ?? randomUUID();
      const method = request.body.method ?? 'random';
      const goRound = request.body.go_round ?? 1;
      const commit = request.body.commit ?? false;
      const claims = claimsFor(request.auth!);

      const out = await fastify.db.asUser(claims, async (tx) => {
        const entries = await entriesRepo.loadDrawableEntries(tx, org_id, event_id);
        const performances = await entriesRepo.loadPerformanceSlots(tx, org_id, rodeo_id);

        const draw = generateDraw({
          entries: entries.map((e) => ({
            entry_id: e.entry_id,
            contestant_id: e.contestant_id,
            buddy_group_id: e.buddy_group_id,
            division: e.division,
            entered_seq: e.entered_seq,
            slot: e.slot,
          })),
          performances,
          seed,
          method,
          go_round: goRound,
        });

        // A draw with anybody unplaced is not committed. Half a draw is worse
        // than none: the entries that did land would have to be undone.
        if (commit && draw.ok) {
          await entriesRepo.saveDraw(tx, {
            org_id,
            rodeo_event_id: event_id,
            seed,
            method,
            assignments: draw.assignments,
            actor_id: request.auth!.user.user_id,
          });
        }

        return { draw, committed: commit && draw.ok };
      });

      if (!out.draw.ok) {
        return reply.status(422).send({
          error: {
            code: 'DRAW_FAILED',
            message: 'The draw could not be completed; nothing was written.',
            details: { issues: out.draw.issues, unplaced: out.draw.unplaced },
          },
          meta: { request_id: request.id },
        });
      }

      return reply.send({
        data: {
          seed: out.draw.seed,
          method: out.draw.method,
          committed: out.committed,
          assignments: out.draw.assignments,
          warnings: out.draw.issues.filter((i) => i.severity === 'warning'),
        },
        meta: { request_id: request.id },
      });
    },
  );

  /** POST .../events/:event_id/draw/stock */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Body: {
      seed?: string;
      animal_type: string;
      go_round?: number;
      allow_reuse?: boolean;
      commit?: boolean;
    };
  }>(
    '/rodeos/:rodeo_id/events/:event_id/draw/stock',
    {
      schema: {
        body: {
          type: 'object',
          required: ['animal_type'],
          additionalProperties: false,
          properties: {
            seed: { type: 'string', minLength: 4, maxLength: 128 },
            animal_type: { type: 'string', maxLength: 32 },
            go_round: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
            allow_reuse: { type: 'boolean', default: false },
            commit: { type: 'boolean', default: false },
          },
        },
      },
      preHandler: requirePermission('draw.generate'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id, event_id } = request.params;
      const seed = request.body.seed ?? randomUUID();
      const goRound = request.body.go_round ?? 1;
      const claims = claimsFor(request.auth!);

      const out = await fastify.db.asUser(claims, async (tx) => {
        const entries = await entriesRepo.loadDrawableEntries(tx, org_id, event_id);
        const performances = await entriesRepo.loadPerformanceSlots(tx, org_id, rodeo_id);
        const animals = await entriesRepo.loadDrawableAnimals(
          tx,
          org_id,
          request.body.animal_type,
        );

        // The stock draw follows the performance draw, so re-derive it from
        // the same seed rather than re-reading half-written positions.
        const contestantDraw = generateDraw({
          entries: entries.map((e) => ({
            entry_id: e.entry_id,
            contestant_id: e.contestant_id,
            entered_seq: e.entered_seq,
          })),
          performances,
          seed,
          method: 'random',
          go_round: goRound,
        });

        const stock = generateStockDraw({
          assignments: contestantDraw.assignments,
          animals,
          seed,
          go_round: goRound,
          allow_reuse: request.body.allow_reuse,
        });

        if (request.body.commit && stock.ok) {
          await entriesRepo.saveStockDraw(tx, {
            org_id,
            rodeo_id,
            rodeo_event_id: event_id,
            assignments: stock.assignments,
          });
        }

        return { stock, committed: (request.body.commit ?? false) && stock.ok };
      });

      if (!out.stock.ok) {
        return reply.status(422).send({
          error: {
            code: 'STOCK_DRAW_FAILED',
            message: 'The stock draw could not be completed; nothing was written.',
            details: { issues: out.stock.issues, unmatched: out.stock.unmatched },
          },
          meta: { request_id: request.id },
        });
      }

      return reply.send({
        data: {
          seed: out.stock.seed,
          committed: out.committed,
          assignments: out.stock.assignments,
          warnings: out.stock.issues.filter((i) => i.severity === 'warning'),
        },
        meta: { request_id: request.id },
      });
    },
  );

  /** POST .../entries/:entry_id/redraw — turnout, reride, or sore stock. */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; entry_id: string };
    Body: {
      rodeo_event_id: string;
      current_animal_id: string;
      original_draw_id: string;
      animal_type: string;
      reason: 'turnout' | 'reride' | 'animal_issue';
      go_round?: number;
      seed?: string;
    };
  }>(
    '/rodeos/:rodeo_id/entries/:entry_id/redraw',
    {
      schema: {
        body: {
          type: 'object',
          required: [
            'rodeo_event_id',
            'current_animal_id',
            'original_draw_id',
            'animal_type',
            'reason',
          ],
          additionalProperties: false,
          properties: {
            rodeo_event_id: { type: 'string', format: 'uuid' },
            current_animal_id: { type: 'string', format: 'uuid' },
            original_draw_id: { type: 'string', format: 'uuid' },
            animal_type: { type: 'string', maxLength: 32 },
            reason: { type: 'string', enum: ['turnout', 'reride', 'animal_issue'] },
            go_round: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
            seed: { type: 'string', minLength: 4, maxLength: 128 },
          },
        },
      },
      preHandler: requirePermission('draw.generate'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id, entry_id } = request.params;
      const body = request.body;
      const goRound = body.go_round ?? 1;
      const seed = body.seed ?? randomUUID();

      const out = await fastify.db.asUser(claimsFor(request.auth!), async (tx) => {
        const animals = await entriesRepo.loadDrawableAnimals(
          tx,
          org_id,
          body.animal_type,
        );
        const alreadyDrawn = await entriesRepo.loadDrawnAnimals(
          tx,
          org_id,
          body.rodeo_event_id,
          goRound,
        );

        const pick = redrawStock({
          entry_id,
          current_animal_id: body.current_animal_id,
          animals,
          already_drawn: alreadyDrawn,
          seed,
          reason: body.reason,
          go_round: goRound,
        });

        if (!pick.ok || !pick.animal_id) return { pick, draw_id: null };

        const drawId = await entriesRepo.recordRedraw(tx, {
          org_id,
          rodeo_id,
          rodeo_event_id: body.rodeo_event_id,
          entry_id,
          original_draw_id: body.original_draw_id,
          animal_id: pick.animal_id,
          reason: body.reason,
          go_round: goRound,
        });

        return { pick, draw_id: drawId };
      });

      if (!out.pick.ok) {
        return reply.status(422).send({
          error: {
            code: 'REDRAW_FAILED',
            message: 'No stock available to re-draw.',
            details: { issues: out.pick.issues },
          },
          meta: { request_id: request.id },
        });
      }

      return reply.send({
        data: {
          seed,
          animal_id: out.pick.animal_id,
          stock_draw_id: out.draw_id,
          reason: body.reason,
        },
        meta: { request_id: request.id },
      });
    },
  );
};
