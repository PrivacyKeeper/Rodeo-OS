/**
 * Public, unauthenticated endpoints.
 *
 * Architecture ref: §4.1 "PUBLIC", §4.5.
 *
 * These are what a spectator's phone hits from the stands and what a local
 * paper embeds. They are rate limited by IP, cached at the edge, and never
 * expose anything that is not already on the arena scoreboard — the RLS
 * policies in 0008 make results readable only once the rodeo is at least
 * in progress and the score is official.
 */

import type { FastifyPluginAsync } from 'fastify';

import { isUuid } from '../../core/auth.ts';
import * as repo from '../../core/database/repositories.ts';

export const registerPublicModule: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { rodeo_id: string } }>(
    '/rodeos/:rodeo_id/results',
    async (request, reply) => {
      if (!isUuid(request.params.rodeo_id)) {
        return reply.status(400).send({
          error: { code: 'BAD_RODEO_ID', message: 'rodeo_id must be a UUID.' },
          meta: { request_id: request.id },
        });
      }

      // Anonymous: only the public-read policies match, so a draft rodeo or a
      // provisional score cannot escape through this route.
      const results = await fastify.db.asAnon((tx) =>
        repo.loadPublicResults(tx, request.params.rodeo_id),
      );

      if (!results) {
        return reply.status(404).send({
          error: { code: 'RODEO_NOT_FOUND', message: 'No published rodeo with that id.' },
          meta: { request_id: request.id },
        });
      }

      // Results change slowly once official; let the edge serve them.
      reply.header('cache-control', 'public, max-age=30, stale-while-revalidate=300');

      return reply.send({
        data: results,
        meta: { request_id: request.id, timestamp: new Date().toISOString() },
      });
    },
  );

  /**
   * Server-sent events for live scores.
   *
   * SSE rather than WebSockets for the spectator side (Appendix A): the flow
   * is one-directional, browsers reconnect on their own, and it survives a CDN
   * in front of it. The arena terminals use WebSockets, which is the other
   * half of that decision.
   */
  fastify.get<{ Params: { rodeo_id: string } }>(
    '/rodeos/:rodeo_id/live',
    async (request, reply) => {
      if (!isUuid(request.params.rodeo_id)) {
        return reply.status(400).send({
          error: { code: 'BAD_RODEO_ID', message: 'rodeo_id must be a UUID.' },
          meta: { request_id: request.id },
        });
      }

      const rodeoId = request.params.rodeo_id;

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      send('connected', { rodeo_id: rodeoId });

      const onScore = (payload: { org_id: string; score_id: string }) => {
        send('score_update', payload);
      };
      fastify.eventBus.on('score.finalized', onScore);

      // Rural connections drop silently; a periodic comment keeps proxies from
      // reaping the socket and tells the client we are still here.
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);

      request.raw.on('close', () => {
        clearInterval(heartbeat);
        fastify.eventBus.off('score.finalized', onScore);
      });

      return reply;
    },
  );

  fastify.get<{
    Params: { body: string; season: string; event_type: string };
  }>('/standings/:body/:season/:event_type', async (request, reply) => {
    const standings = await fastify.db.asAnon((tx) =>
      repo.loadStandings(
        tx,
        request.params.body,
        request.params.season,
        request.params.event_type,
      ),
    );

    reply.header('cache-control', 'public, max-age=300');
    return reply.send({
      data: standings,
      meta: { request_id: request.id },
    });
  });
};

// Storage lives in core/database/repositories.ts.
