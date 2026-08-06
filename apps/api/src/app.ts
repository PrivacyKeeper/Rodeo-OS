/**
 * Fastify bootstrap and module registration.
 *
 * Architecture ref: §1.2, §3.3.1, §4.6.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { AuthError, makeAuthMiddleware, type TokenVerifier } from './core/auth.ts';
import { TypedEventBus } from './core/events.ts';
import { registerScoringModule } from './modules/scoring/routes.ts';
import { registerPayoutsModule } from './modules/payouts/routes.ts';
import { registerSyncModule } from './modules/sync/routes.ts';
import { registerOptionsModule } from './modules/options/routes.ts';
import { registerPublicModule } from './modules/public/routes.ts';

declare module 'fastify' {
  interface FastifyInstance {
    eventBus: TypedEventBus;
  }
}

export interface BuildOptions {
  verifier: TokenVerifier;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? true,
    // Every response carries a request id so a producer ringing up about a
    // payout can be traced to the exact calculation that produced it.
    genReqId: () => crypto.randomUUID(),
    disableRequestLogging: false,
  });

  app.decorate('eventBus', new TypedEventBus());

  // ---- Uniform response envelope (§4.6) -----------------------------------
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthError) {
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
        },
        meta: { request_id: request.id },
      });
    }

    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error(error);

    return reply.status(status).send({
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        // Never leak an internal message to a client.
        message:
          status >= 500
            ? 'An unexpected error occurred.'
            : error.message,
        details: (error as { details?: unknown }).details,
      },
      meta: { request_id: request.id },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.url}.` },
      meta: { request_id: request.id },
    });
  });

  app.get('/health', async () => ({
    data: { status: 'ok' },
    meta: { timestamp: new Date().toISOString() },
  }));

  // ---- Public routes: no auth ---------------------------------------------
  await app.register(registerPublicModule, { prefix: '/v1/public' });

  // ---- Authenticated routes -----------------------------------------------
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', makeAuthMiddleware(opts.verifier));

    await scoped.register(registerOptionsModule);
    await scoped.register(registerScoringModule);
    await scoped.register(registerPayoutsModule);
    await scoped.register(registerSyncModule);
  }, { prefix: '/v1/orgs/:org_id' });

  return app;
}
