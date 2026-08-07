/**
 * Day sheets.
 *
 * The paper the arena runs on. Two representations of the same computation:
 * JSON for a screen, fixed-width text for the printer in the arena office.
 *
 * The text form is not a nicety. A rodeo can lose its network, its tablets and
 * its power and still run a performance if somebody printed the sheet, and a
 * monospaced page prints identically from every browser and reads at arm's
 * length under a floodlight.
 */

import type { FastifyPluginAsync } from 'fastify';

import { buildDaySheet, renderDaySheetText } from '@rodeo-os/engine';

import { claimsFor } from '../../core/database/client.ts';
import * as ops from '../../core/database/operations-repo.ts';

export const registerDaySheetModule: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /rodeos/:rodeo_id/day-sheet
   *
   * ?performance=2 scopes to one performance. Omitted gives the whole rodeo,
   * which is what a secretary wants when she is checking a draw rather than
   * running a night.
   *
   * ?format=text returns the printable sheet.
   */
  fastify.get<{
    Params: { org_id: string; rodeo_id: string };
    Querystring: { performance?: string; format?: string; go_round?: string };
  }>(
    '/rodeos/:rodeo_id/day-sheet',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            performance: { type: 'string', pattern: '^[0-9]{1,3}$' },
            go_round: { type: 'string', pattern: '^[0-9]{1,2}$' },
            format: { type: 'string', enum: ['json', 'text'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;
      const performance =
        request.query.performance === undefined
          ? null
          : Number(request.query.performance);

      const context = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        ops.loadDaySheet(tx, org_id, rodeo_id, performance),
      );

      if (!context) {
        return reply.status(404).send({
          error: { code: 'RODEO_NOT_FOUND', message: 'No such rodeo.' },
          meta: { request_id: request.id },
        });
      }

      const sheet = buildDaySheet({
        rodeo_id: context.rodeo.id,
        rodeo_name: context.rodeo.name,
        venue: context.rodeo.venue,
        sanctioned_by: context.sanctioned_by,
        performance: {
          id: performance === null ? null : String(performance),
          name: context.performance.name,
          type: context.performance.type,
          date: context.performance.date,
          scheduled_start: context.performance.scheduled_start,
          arena_dragged_after: context.performance.arena_dragged_after,
          condensed_drag: context.performance.condensed_drag,
        },
        events: context.events,
        entries: context.entries,
        stock: context.stock,
        personnel: context.personnel,
        go_rounds: request.query.go_round
          ? [Number(request.query.go_round)]
          : undefined,
      });

      if (request.query.format === 'text') {
        reply.header('content-type', 'text/plain; charset=utf-8');
        return reply.send(renderDaySheetText(sheet));
      }

      return reply.send({
        data: sheet,
        meta: { request_id: request.id, total_runs: sheet.total_runs },
      });
    },
  );
};
