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

      const config = await loadScoringConfig(fastify, body.scoring_config_id);
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
      await persistScore(fastify, {
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
      });

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
      const score = await finalizeScore(fastify, org_id, score_id);

      fastify.eventBus.emit('score.finalized', {
        org_id,
        score_id,
        rodeo_event_id: score.rodeo_event_id,
      });

      return reply.send({
        data: score,
        meta: { request_id: request.id },
      });
    },
  );
};

// ---------------------------------------------------------------------------
// Storage seam. Implemented against Drizzle in src/core/database; declared here
// so the module's contract with persistence is explicit and mockable.
// ---------------------------------------------------------------------------

async function loadScoringConfig(
  _fastify: unknown,
  _id: string,
): Promise<ScoringConfig | null> {
  throw new Error('not implemented: wire to core/database');
}

async function persistScore(_fastify: unknown, _score: unknown): Promise<void> {
  throw new Error('not implemented: wire to core/database');
}

async function finalizeScore(
  _fastify: unknown,
  _orgId: string,
  _scoreId: string,
): Promise<{ rodeo_event_id: string }> {
  throw new Error('not implemented: wire to core/database');
}
