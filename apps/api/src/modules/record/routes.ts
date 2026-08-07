/**
 * The record layer — a person's career and an animal's, across every
 * organisation.
 *
 * ---------------------------------------------------------------------------
 * WHAT KEEPS THIS SAFE
 * ---------------------------------------------------------------------------
 * These are the only routes in the API that read tables which are not
 * tenant-scoped, so they are the only place a cross-tenant leak could come
 * from. Nothing here filters by organisation in application code, on purpose:
 * the policies on career_runs do it, and they grant exactly three things —
 *
 *   your own runs, everywhere;
 *   runs recorded at an organisation you are staff of;
 *   nothing else.
 *
 * A handler that forgot a predicate would return too little, never somebody
 * else's career. That is the same property the rest of the API relies on and
 * it is why the check lives in the database.
 */

import type { FastifyPluginAsync } from 'fastify';

import { isUuid, requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as ops from '../../core/database/operations-repo.ts';

export const registerRecordModule: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /contestants/:contestant_id/career
   *
   * Every run this person has made, wherever it happened — including rodeos
   * that were never on this platform. That completeness is the product: no
   * cowboy in America can currently see everything they have won this year in
   * one place.
   */
  fastify.get<{
    Params: { org_id: string; contestant_id: string };
    Querystring: { limit?: number };
  }>(
    '/contestants/:contestant_id/career',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 1000 } },
        },
      },
    },
    async (request, reply) => {
      const { contestant_id } = request.params;
      if (!isUuid(contestant_id)) {
        return reply.status(400).send({
          error: { code: 'BAD_ID', message: 'contestant_id must be a uuid.' },
          meta: { request_id: request.id },
        });
      }

      const out = await fastify.db.asUser(claimsFor(request.auth!), async (tx) => {
        const runs = await ops.loadCareer(tx, contestant_id, request.query.limit ?? 500);
        const summary = await ops.careerSummary(tx, contestant_id);
        return { runs, summary };
      });

      const total = out.runs.reduce((t, r) => t + Number(r.earnings_cents), 0);

      return reply.send({
        data: {
          runs: out.runs,
          by_season: out.summary,
          total_earnings_cents: total,
          // Says plainly how much of this is ours to vouch for. A record that
          // mixes official results with a contestant's own typing, without
          // saying which is which, is worth nothing.
          verified_runs: out.runs.filter((r) => r.is_verified).length,
        },
        meta: { request_id: request.id, runs: out.runs.length },
      });
    },
  );

  /**
   * GET /registry?q=dash&type=horse
   *
   * The horse lookup a secretary uses while taking an entry. Matching an
   * existing registry row instead of typing a new name is what stops the same
   * horse existing five times, which is what makes its career record real.
   */
  fastify.get<{
    Params: { org_id: string };
    Querystring: { q: string; type?: string; limit?: number };
  }>(
    '/registry',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          additionalProperties: false,
          properties: {
            q: { type: 'string', minLength: 2, maxLength: 80 },
            type: {
              type: 'string',
              enum: ['bull', 'saddle_bronc', 'bareback_bronc', 'calf', 'steer', 'horse', 'goat'],
            },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.searchRegistry(
          tx,
          request.query.q,
          request.query.type ?? null,
          request.query.limit ?? 25,
        ),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  /** POST /registry — add a horse that is not in there yet. */
  fastify.post<{
    Params: { org_id: string };
    Body: {
      barn_name: string;
      registered_name?: string;
      animal_type: string;
      breed?: string;
      sex?: string;
      foaled_year?: number;
      owner_user_id?: string;
    };
  }>(
    '/registry',
    {
      schema: {
        body: {
          type: 'object',
          required: ['barn_name', 'animal_type'],
          additionalProperties: false,
          properties: {
            barn_name: { type: 'string', minLength: 1, maxLength: 120 },
            registered_name: { type: 'string', maxLength: 200 },
            animal_type: {
              type: 'string',
              enum: ['bull', 'saddle_bronc', 'bareback_bronc', 'calf', 'steer', 'horse', 'goat'],
            },
            breed: { type: 'string', maxLength: 80 },
            sex: { type: 'string', enum: ['male', 'female', 'gelding', 'steer'] },
            foaled_year: { type: 'integer', minimum: 1950, maximum: 2100 },
            owner_user_id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: requirePermission('registry.manage'),
    },
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.createRegistryAnimal(tx, request.params.org_id, request.body),
      );
      return reply.status(201).send({ data: row, meta: { request_id: request.id } });
    },
  );

  /**
   * GET /registry/:animal_id/career
   *
   * What a horse has done and won. Nobody else in the sport keeps this, and a
   * barrel horse's record is a large part of what the horse is worth.
   */
  fastify.get<{ Params: { org_id: string; animal_id: string } }>(
    '/registry/:animal_id/career',
    async (request, reply) => {
      const { animal_id } = request.params;
      if (!isUuid(animal_id)) {
        return reply.status(400).send({
          error: { code: 'BAD_ID', message: 'animal_id must be a uuid.' },
          meta: { request_id: request.id },
        });
      }
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.animalCareer(tx, animal_id),
      );
      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NO_RECORD',
            message: 'That animal has no public competitive record.',
          },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: row, meta: { request_id: request.id } });
    },
  );
};
