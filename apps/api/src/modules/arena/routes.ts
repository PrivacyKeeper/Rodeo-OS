/**
 * Arena operations — results, stock and personnel.
 *
 * The three things that had tables and engines behind them and no surface a
 * secretary could reach. Nothing new is invented here; these are the routes
 * the existing schema always implied.
 */

import type { FastifyPluginAsync } from 'fastify';

import { isUuid, requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as ops from '../../core/database/operations-repo.ts';

export const registerArenaModule: FastifyPluginAsync = async (fastify) => {
  // =======================================================================
  // Results
  // =======================================================================

  /** GET /rodeos/:rodeo_id/results — every placing, official or not. */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/results',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.loadResults(tx, request.params.org_id, request.params.rodeo_id),
      );
      return reply.send({
        data: rows,
        meta: {
          request_id: request.id,
          official: rows.filter((r) => r.is_official).length,
          provisional: rows.filter((r) => !r.is_official).length,
        },
      });
    },
  );

  /**
   * POST /rodeos/:rodeo_id/events/:event_id/publish
   *
   * Flips a whole event's placings to official — which is also the moment they
   * become visible on the public scoreboard, to the apps, and to season
   * standings. One action, so a secretary is never left with half an event
   * published.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Body: { official?: boolean };
  }>(
    '/rodeos/:rodeo_id/events/:event_id/publish',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { official: { type: 'boolean', default: true } },
        },
      },
      preHandler: requirePermission('score.correct'),
    },
    async (request, reply) => {
      const official = request.body?.official ?? true;
      const changed = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.setResultsOfficial(tx, request.params.org_id, request.params.event_id, official),
      );
      return reply.send({
        data: { updated: changed, official },
        meta: { request_id: request.id },
      });
    },
  );

  // =======================================================================
  // Stock
  // =======================================================================

  fastify.get<{
    Params: { org_id: string };
    Querystring: { rodeo_id?: string };
  }>(
    '/animals',
    async (request, reply) => {
      const rodeoId = request.query.rodeo_id ?? null;
      if (rodeoId && !isUuid(rodeoId)) {
        return reply.status(400).send({
          error: { code: 'BAD_ID', message: 'rodeo_id must be a uuid.' },
          meta: { request_id: request.id },
        });
      }
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.listAnimals(tx, request.params.org_id, rodeoId),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  fastify.post<{ Params: { org_id: string }; Body: ops.NewAnimal }>(
    '/animals',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'animal_type'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            animal_type: {
              type: 'string',
              enum: ['bull', 'saddle_bronc', 'bareback_bronc', 'calf', 'steer', 'horse', 'goat'],
            },
            brand_number: { type: 'string', maxLength: 32 },
            breed: { type: 'string', maxLength: 80 },
            contractor_id: { type: 'string', format: 'uuid' },
            // Linking to the global registry is what gives a bull a career
            // record that survives changing contractors.
            registry_id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: requirePermission('stock.manage'),
    },
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.createAnimal(tx, request.params.org_id, request.body),
      );
      return reply.status(201).send({ data: row, meta: { request_id: request.id } });
    },
  );

  fastify.patch<{
    Params: { org_id: string; animal_id: string };
    Body: { health_status: string };
  }>(
    '/animals/:animal_id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['health_status'],
          additionalProperties: false,
          properties: {
            health_status: {
              type: 'string',
              enum: ['active', 'injured', 'retired', 'deceased'],
            },
          },
        },
      },
      preHandler: requirePermission('stock.manage'),
    },
    async (request, reply) => {
      const ok = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.setAnimalHealth(tx, request.params.org_id, request.params.animal_id,
                            request.body.health_status),
      );
      if (!ok) {
        return reply.status(404).send({
          error: { code: 'ANIMAL_NOT_FOUND', message: 'No such animal.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: { updated: true }, meta: { request_id: request.id } });
    },
  );

  // =======================================================================
  // Personnel and credentials
  // =======================================================================

  /**
   * GET /rodeos/:rodeo_id/personnel
   *
   * Who is working it, whether they are carded, and what is missing. The
   * shortfall comes from `personnel_shortfall()`, which is the thing that lets
   * a committee find out it is a judge short BEFORE the rodeo.
   */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/personnel',
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;
      const out = await fastify.db.asUser(claimsFor(request.auth!), async (tx) => {
        const assigned = await ops.listPersonnel(tx, org_id, rodeo_id);
        const books = await ops.loadBooks(tx, org_id, rodeo_id);
        return { assigned, shortfall: books?.personnel_shortfall ?? [] };
      });
      return reply.send({
        data: out,
        meta: { request_id: request.id, short: out.shortfall.length },
      });
    },
  );

  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: { user_id: string; role: string; fee_cents?: number };
  }>(
    '/rodeos/:rodeo_id/personnel',
    {
      schema: {
        body: {
          type: 'object',
          required: ['user_id', 'role'],
          additionalProperties: false,
          properties: {
            user_id: { type: 'string', format: 'uuid' },
            role: { type: 'string', minLength: 1, maxLength: 48 },
            fee_cents: { type: 'integer', minimum: 0, maximum: 100_000_00 },
          },
        },
      },
      preHandler: requirePermission('personnel.manage'),
    },
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.assignPersonnel(tx, request.params.org_id, request.params.rodeo_id,
                            request.body.user_id, request.body.role,
                            request.body.fee_cents ?? null),
      );
      return reply.status(201).send({ data: row, meta: { request_id: request.id } });
    },
  );

  fastify.delete<{ Params: { org_id: string; rodeo_id: string; personnel_id: string } }>(
    '/rodeos/:rodeo_id/personnel/:personnel_id',
    { preHandler: requirePermission('personnel.manage') },
    async (request, reply) => {
      const ok = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.removePersonnel(tx, request.params.org_id, request.params.personnel_id),
      );
      if (!ok) {
        return reply.status(404).send({
          error: { code: 'NOT_ASSIGNED', message: 'Not on this rodeo.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: { removed: true }, meta: { request_id: request.id } });
    },
  );

  fastify.get<{ Params: { org_id: string; user_id: string } }>(
    '/people/:user_id/credentials',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.listCredentials(tx, request.params.user_id),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  fastify.post<{
    Params: { org_id: string; user_id: string };
    Body: {
      body_code: string;
      role: string;
      card_number?: string;
      card_class?: string;
      issued_on?: string;
      expires_on?: string;
    };
  }>(
    '/people/:user_id/credentials',
    {
      schema: {
        body: {
          type: 'object',
          required: ['body_code', 'role'],
          additionalProperties: false,
          properties: {
            body_code: { type: 'string', minLength: 2, maxLength: 24 },
            role: { type: 'string', minLength: 2, maxLength: 48 },
            card_number: { type: 'string', maxLength: 48 },
            card_class: {
              type: 'string',
              enum: ['full', 'probationary', 'permit', 'apprentice'],
            },
            issued_on: { type: 'string', format: 'date' },
            expires_on: { type: 'string', format: 'date' },
          },
        },
      },
      preHandler: requirePermission('personnel.manage'),
    },
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.addCredential(tx, request.params.user_id, request.body),
      );
      return reply.status(201).send({
        data: { ...row, verified: false },
        meta: {
          request_id: request.id,
          // Said explicitly: an unverified card counts for nothing in
          // credential_is_current(), so the shortfall report will still show
          // the rodeo short until somebody checks it.
          note: 'Unverified. It does not count towards the requirement until checked.',
        },
      });
    },
  );

  /** POST /credentials/:credential_id/verify — somebody actually looked at it. */
  fastify.post<{ Params: { org_id: string; credential_id: string } }>(
    '/credentials/:credential_id/verify',
    { preHandler: requirePermission('personnel.manage') },
    async (request, reply) => {
      const ok = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.verifyCredential(tx, request.params.credential_id, request.auth!.user.user_id),
      );
      if (!ok) {
        return reply.status(404).send({
          error: { code: 'CREDENTIAL_NOT_FOUND', message: 'No such credential.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: { verified: true }, meta: { request_id: request.id } });
    },
  );
};
