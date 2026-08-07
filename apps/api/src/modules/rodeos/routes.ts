/**
 * Setting up a rodeo.
 *
 * ---------------------------------------------------------------------------
 * ONE POST. FIVE ANSWERS.
 * ---------------------------------------------------------------------------
 * What are you running, which events, sanctioned by anybody, how do you pay
 * out, what are the fees. Everything else the system needs is derived: the
 * scoring mode comes from the event's option metadata, the compliance calendar
 * comes from the association, the rules come from the config templates.
 *
 * The alternative — create a rodeo, then add events to it one at a time, then
 * remember to attach a payout config — is a database with a form on it. A
 * secretary setting up a Tuesday roping should be finished in under a minute
 * and should never have been asked a single question a Tuesday roping does not
 * have an answer to.
 */

import type { FastifyPluginAsync } from 'fastify';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as ops from '../../core/database/operations-repo.ts';

/** A URL-safe slug from whatever the producer typed as a name. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'rodeo'
  );
}

export const registerRodeosModule: FastifyPluginAsync = async (fastify) => {
  /** GET /rodeos — the secretary's home screen. */
  fastify.get<{ Params: { org_id: string } }>('/rodeos', async (request, reply) => {
    const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
      ops.listRodeos(tx, request.params.org_id),
    );
    return reply.send({ data: rows, meta: { request_id: request.id } });
  });

  /** GET /rodeos/:rodeo_id */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id',
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.loadRodeo(tx, request.params.org_id, request.params.rodeo_id),
      );
      if (!row) {
        return reply.status(404).send({
          error: { code: 'RODEO_NOT_FOUND', message: 'No such rodeo.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: row, meta: { request_id: request.id } });
    },
  );

  /** POST /rodeos — the whole setup screen, in one call. */
  fastify.post<{
    Params: { org_id: string };
    Body: ops.NewRodeo & { slug?: string };
  }>(
    '/rodeos',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'rodeo_type', 'start_date', 'end_date', 'events'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,59}$' },
            // Validated against reference_options by the database trigger, not
            // by an enum here: a producer who added their own rodeo type must
            // be able to use it without us shipping anything.
            rodeo_type: { type: 'string', minLength: 1, maxLength: 48 },
            start_date: { type: 'string', format: 'date' },
            end_date: { type: 'string', format: 'date' },
            timezone: { type: 'string', maxLength: 64 },
            venue_name: { type: 'string', maxLength: 200 },
            venue_city: { type: 'string', maxLength: 120 },
            venue_state: { type: 'string', maxLength: 60 },
            num_performances: { type: 'integer', minimum: 1, maximum: 60 },
            num_go_rounds: { type: 'integer', minimum: 1, maximum: 20 },
            sanctioning: {
              type: 'array',
              maxItems: 8,
              items: { type: 'string', maxLength: 24 },
            },
            events: {
              type: 'array',
              minItems: 1,
              maxItems: 60,
              items: {
                type: 'object',
                required: ['event_type', 'scoring_mode'],
                additionalProperties: false,
                properties: {
                  event_type: { type: 'string', minLength: 1, maxLength: 48 },
                  scoring_mode: { type: 'string', enum: ['judged', 'timed'] },
                  is_roughstock: { type: 'boolean' },
                  entry_fee: { type: 'number', minimum: 0, maximum: 100000 },
                  added_money: { type: 'number', minimum: 0, maximum: 10000000 },
                  stock_charge: { type: 'number', minimum: 0, maximum: 100000 },
                  num_go_rounds: { type: 'integer', minimum: 1, maximum: 20 },
                  scoring_config_id: { type: 'string', format: 'uuid' },
                  payout_config_id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
      },
      preHandler: requirePermission('rodeo.create'),
    },
    async (request, reply) => {
      const { org_id } = request.params;
      const body = request.body;

      if (body.end_date < body.start_date) {
        return reply.status(400).send({
          error: {
            code: 'BAD_DATES',
            message: 'The rodeo cannot end before it starts.',
          },
          meta: { request_id: request.id },
        });
      }

      const slug = body.slug ?? slugify(body.name);

      try {
        const created = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
          ops.createRodeo(tx, org_id, { ...body, slug }),
        );
        return reply.status(201).send({
          data: created,
          meta: {
            request_id: request.id,
            // Said back explicitly so the interface can show a jackpot nothing
            // and a sanctioned rodeo its calendar.
            compliance_items: created.compliance_items,
          },
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23505') {
          return reply.status(409).send({
            error: {
              code: 'SLUG_TAKEN',
              message: `You already have a rodeo at '${slug}'.`,
            },
            meta: { request_id: request.id },
          });
        }
        // The reference-options trigger rejects an event type or rodeo type
        // that does not exist for this tenant. That is a 400, not a 500.
        if (code === '23514' || code === 'P0001') {
          return reply.status(400).send({
            error: {
              code: 'UNKNOWN_OPTION',
              message: (err as Error).message,
            },
            meta: { request_id: request.id },
          });
        }
        throw err;
      }
    },
  );
};
