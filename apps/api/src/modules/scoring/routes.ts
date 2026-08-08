/**
 * Scoring module routes.
 *
 * Architecture ref: §4.1 "SCORES", §5.
 *
 * The route layer validates the shape of a request and hands the numbers to
 * @rodeo-os/engine. No scoring arithmetic lives here — the engine is pure and
 * tested in isolation, and the same functions run in the secretary's browser
 * when the arena is offline.
 */

import type { FastifyPluginAsync } from 'fastify';

import {
  calculateJudgedScore,
  calculateTimedScore,
  type ScoringConfig,
} from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as repo from '../../core/database/repositories.ts';

interface SubmitScoreBody {
  entry_id: string;
  contestant_id: string;
  go_round?: number;
  performance?: number;
  animal_id?: string;
  scoring_config_id: string;
  source?: 'manual' | 'timer_hardware' | 'web_serial' | 'timer_bridge' | 'import';
  hardware_timestamp?: number;

  // judged
  judges?: {
    judge_id: string;
    judge_position: number;
    components: { name: string; value: number }[];
  }[];
  marked_out?: boolean;

  // timed
  raw_time?: number | null;
  penalties?: { type: string; count?: number }[];
  barrels_knocked?: number;
  tie_held_seconds?: number;

  dq_triggers?: string[];
}

const submitScoreSchema = {
  body: {
    type: 'object',
    required: ['entry_id', 'contestant_id', 'scoring_config_id'],
    additionalProperties: false,
    properties: {
      entry_id: { type: 'string', format: 'uuid' },
      contestant_id: { type: 'string', format: 'uuid' },
      go_round: { type: 'integer', minimum: 1, default: 1 },
      performance: { type: 'integer', minimum: 1 },
      animal_id: { type: 'string', format: 'uuid' },
      scoring_config_id: { type: 'string', format: 'uuid' },
      source: {
        type: 'string',
        enum: ['manual', 'timer_hardware', 'web_serial', 'timer_bridge', 'import'],
        default: 'manual',
      },
      hardware_timestamp: { type: 'integer' },
      judges: {
        type: 'array',
        items: {
          type: 'object',
          required: ['judge_id', 'judge_position', 'components'],
          additionalProperties: false,
          properties: {
            judge_id: { type: 'string', format: 'uuid' },
            judge_position: { type: 'integer', minimum: 1, maximum: 4 },
            components: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['name', 'value'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string', maxLength: 32 },
                  value: { type: 'number', minimum: 0, maximum: 100 },
                },
              },
            },
          },
        },
      },
      marked_out: { type: 'boolean' },
      raw_time: { type: ['number', 'null'], minimum: 0, maximum: 3600 },
      penalties: {
        type: 'array',
        items: {
          type: 'object',
          required: ['type'],
          additionalProperties: false,
          properties: {
            type: { type: 'string', maxLength: 48 },
            count: { type: 'integer', minimum: 1, maximum: 10 },
          },
        },
      },
      barrels_knocked: { type: 'integer', minimum: 0, maximum: 3 },
      tie_held_seconds: { type: 'number', minimum: 0, maximum: 600 },
      dq_triggers: {
        type: 'array',
        items: { type: 'string', maxLength: 64 },
      },
    },
  },
} as const;

export const registerScoringModule: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /v1/orgs/:org_id/rodeos/:rodeo_id/events/:event_id/scores
   *
   * Calculates the score but stores it as `provisional`. Nothing becomes
   * official until a secretary finalises it, because the arena regularly
   * reverses a call between the run and the results going up.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Body: SubmitScoreBody;
  }>(
    '/rodeos/:rodeo_id/events/:event_id/scores',
    {
      schema: submitScoreSchema,
      preHandler: requirePermission('score.submit'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id, event_id } = request.params;
      const body = request.body;

      // Every database call in this handler runs as the caller, so RLS is what
      // decides whether this config and this entry are theirs to touch.
      const claims = claimsFor(request.auth!);

      const config = await fastify.db.asUser(claims, (tx) =>
        repo.loadScoringConfig(tx, body.scoring_config_id),
      );
      if (!config) {
        return reply.status(404).send({
          error: {
            code: 'SCORING_CONFIG_NOT_FOUND',
            message: `No scoring config ${body.scoring_config_id}.`,
          },
          meta: { request_id: request.id },
        });
      }

      const result =
        config.mode === 'judged'
          ? calculateJudgedScore(
              {
                judges: body.judges ?? [],
                marked_out: body.marked_out,
                dq_triggers: body.dq_triggers,
              },
              config,
            )
          : calculateTimedScore(
              {
                raw_time: body.raw_time ?? null,
                penalties: body.penalties,
                barrels_knocked: body.barrels_knocked,
                tie_held_seconds: body.tie_held_seconds,
                source: body.source,
                dq_triggers: body.dq_triggers,
              },
              config,
            );

      if (!result.valid) {
        return reply.status(422).send({
          error: {
            code: 'SCORE_VALIDATION_FAILED',
            message: 'The submitted score is not valid for this event.',
            details: { issues: result.issues },
          },
          meta: { request_id: request.id },
        });
      }

      const scoreId = crypto.randomUUID();

      // Persistence is the storage layer's job; this module hands it a value
      // object it has already validated.
      await fastify.db.asUser(claims, (tx) =>
        repo.persistScore(tx, {
          id: scoreId,
          org_id,
          rodeo_id,
          rodeo_event_id: event_id,
          entry_id: body.entry_id,
          contestant_id: body.contestant_id,
          go_round: body.go_round ?? 1,
          performance: body.performance,
          animal_id: body.animal_id,
          scoring_config_id: body.scoring_config_id,
          source: body.source ?? 'manual',
          hardware_timestamp: body.hardware_timestamp,
          entered_by: request.auth!.user.user_id,
          result,
        }),
      );

      fastify.eventBus.emit('score.submitted', {
        org_id,
        score_id: scoreId,
        rodeo_event_id: event_id,
      });

      return reply.status(201).send({
        data: {
          id: scoreId,
          status: result.status,
          ...(result.kind === 'judged'
            ? {
                final_score: result.final_score,
                rider_score: result.rider_score,
                animal_score: result.animal_score,
              }
            : {
                raw_time: result.raw_time,
                final_time: result.final_time,
                penalty_seconds: result.penalty_seconds,
                penalties_applied: result.penalties_applied,
              }),
          // Warnings do not block the score but the secretary must see them —
          // a variance-cap flag is exactly the case §5.7 wants reviewed.
          warnings: result.issues.filter((i) => i.severity === 'warning'),
          dq_reason: result.dq_reason,
        },
        meta: { request_id: request.id, timestamp: new Date().toISOString() },
      });
    },
  );

  /** POST .../scores/:score_id/finalize — provisional becomes official. */
  fastify.post<{ Params: { org_id: string; score_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/scores/:score_id/finalize',
    { preHandler: requirePermission('score.correct') },
    async (request, reply) => {
      const { org_id, score_id } = request.params;
      const score = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        repo.finalizeScore(tx, org_id, score_id, request.auth!.user.user_id),
      );

      // Null covers three cases: no such score, it belongs to another tenant,
      // or somebody already finalised it. All three are a 404 to the caller —
      // distinguishing them would confirm another tenant's record exists.
      if (!score) {
        return reply.status(404).send({
          error: {
            code: 'SCORE_NOT_FINALIZABLE',
            message: 'No provisional score with that id.',
          },
          meta: { request_id: request.id },
        });
      }

      fastify.eventBus.emit('score.finalized', {
        org_id,
        score_id,
        rodeo_event_id: score.rodeo_event_id,
      });

      return reply.send({ data: score, meta: { request_id: request.id } });
    },
  );
  /**
   * POST .../scores/:score_id/correct
   *
   * A judge's sheet says something different from the terminal. This is an
   * ordinary operation and it is on the same footing as entering the score in
   * the first place — the difference is that the trigger records the old
   * value, the new one, who changed it and why, and that history cannot be
   * shortened by anybody including us.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; score_id: string };
    Body: {
      final_time?: number | null;
      final_score?: number | null;
      raw_time?: number | null;
      reason: string;
    };
  }>(
    '/rodeos/:rodeo_id/scores/:score_id/correct',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: {
            final_time: { type: ['number', 'null'], minimum: 0, maximum: 3600 },
            final_score: { type: ['number', 'null'], minimum: 0, maximum: 100 },
            raw_time: { type: ['number', 'null'], minimum: 0, maximum: 3600 },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
      preHandler: requirePermission('score.correct'),
    },
    async (request, reply) => {
      const { org_id, score_id } = request.params;
      const body = request.body;

      // A run is timed XOR judged, and the schema enforces it. Sending both
      // would be rejected by the CHECK with a message nobody can act on, so
      // it is refused here with one they can.
      if (body.final_time != null && body.final_score != null) {
        return reply.status(400).send({
          error: {
            code: 'TIMED_XOR_JUDGED',
            message: 'A run has a time or a score, never both.',
          },
          meta: { request_id: request.id },
        });
      }

      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        repo.correctScore(tx, org_id, score_id, request.auth!.user.user_id, body),
      );
      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'SCORE_NOT_CORRECTABLE',
            message: 'No provisional or official score with that id.',
          },
          meta: { request_id: request.id },
        });
      }

      fastify.eventBus.emit('score.corrected', {
        org_id,
        score_id,
        // The bus carries the shape of the change; the durable record of what
        // it was before is in edit_history, written by the trigger.
        field: body.final_time != null ? 'final_time' : 'final_score',
        from: null,
        to: body.final_time ?? body.final_score ?? null,
        by: request.auth!.user.user_id,
      });

      return reply.send({
        data: {
          ...row,
          // Said out loud, because it is the thing a secretary forgets and
          // then wonders why the placings did not move.
          next_step: 'Re-finalise the event so the placings and payouts follow.',
        },
        meta: { request_id: request.id },
      });
    },
  );

  /** POST .../scores/:score_id/dq */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; score_id: string };
    Body: { reason: string };
  }>(
    '/rodeos/:rodeo_id/scores/:score_id/dq',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } },
        },
      },
      preHandler: requirePermission('score.dq'),
    },
    async (request, reply) => {
      const { org_id, score_id } = request.params;
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        repo.disqualifyScore(tx, org_id, score_id, request.auth!.user.user_id,
                             request.body.reason),
      );
      if (!row) {
        return reply.status(404).send({
          error: { code: 'SCORE_NOT_FOUND', message: 'No live score with that id.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({
        data: { ...row, next_step: 'Re-finalise the event.' },
        meta: { request_id: request.id },
      });
    },
  );

  /**
   * POST .../scores/:score_id/reride
   *
   * Marks the original 'reride', which frees the one-live-score-per-entry slot
   * so the replacement run can be scored normally. The original is never
   * deleted — it is the evidence that a re-ride was given and why.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; score_id: string };
    Body: { reason: string };
  }>(
    '/rodeos/:rodeo_id/scores/:score_id/reride',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } },
        },
      },
      preHandler: requirePermission('score.dq'),
    },
    async (request, reply) => {
      const { org_id, score_id } = request.params;
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        repo.markReride(tx, org_id, score_id, request.auth!.user.user_id,
                        request.body.reason),
      );
      if (!row) {
        return reply.status(404).send({
          error: { code: 'SCORE_NOT_FOUND', message: 'No live score with that id.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({
        data: { ...row, next_step: 'Score the re-ride as a new run.' },
        meta: { request_id: request.id },
      });
    },
  );

  /** GET .../events/:event_id/score-sheet — every run, with its history. */
  fastify.get<{ Params: { org_id: string; rodeo_id: string; event_id: string } }>(
    '/rodeos/:rodeo_id/events/:event_id/score-sheet',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        repo.loadScoreSheet(tx, request.params.org_id, request.params.event_id),
      );
      return reply.send({
        data: rows,
        meta: {
          request_id: request.id,
          corrected: rows.filter(
            (r) => Array.isArray(r.edit_history) && r.edit_history.length > 0,
          ).length,
        },
      });
    },
  );
};

// Storage lives in core/database/repositories.ts. This module holds request
// shape, permissions and the engine call; it does not build SQL.
