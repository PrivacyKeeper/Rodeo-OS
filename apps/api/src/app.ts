/**
 * Fastify bootstrap and module registration.
 *
 * Architecture ref: §1.2, §3.3.1, §4.6.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { AuthError, makeAuthMiddleware, type TokenVerifier } from './core/auth.ts';
import type { Database } from './core/database/client.ts';
import { TypedEventBus } from './core/events.ts';
import { registerScoringModule } from './modules/scoring/routes.ts';
import { registerPayoutsModule } from './modules/payouts/routes.ts';
import { registerSyncModule } from './modules/sync/routes.ts';
import { registerEntriesModule } from './modules/entries/routes.ts';
import { registerDrawModule } from './modules/draw/routes.ts';
import { registerOptionsModule } from './modules/options/routes.ts';
import { registerResultsModule } from './modules/results/routes.ts';
import { registerPublicModule } from './modules/public/routes.ts';
import { registerRodeosModule } from './modules/rodeos/routes.ts';
import { registerDeskModule } from './modules/desk/routes.ts';
import { registerArenaModule } from './modules/arena/routes.ts';
import { registerDaySheetModule } from './modules/daysheet/routes.ts';
import { registerBooksModule } from './modules/books/routes.ts';
import { registerSanctionModule } from './modules/sanction/routes.ts';
import { registerRecordModule } from './modules/record/routes.ts';

declare module 'fastify' {
  interface FastifyInstance {
    eventBus: TypedEventBus;
    db: Database;
  }
}

export interface BuildOptions {
  verifier: TokenVerifier;
  db: Database;
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
  app.decorate('db', opts.db);

  // ---- Uniform response envelope (§4.6) -----------------------------------
  app.setErrorHandler((err, request, reply) => {
    const error = err as Error & {
      statusCode?: number;
      code?: string;
      details?: unknown;
    };

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

  app.get('/health', async (_req, reply) => {
    const dbOk = await app.db.healthy();
    return reply.status(dbOk ? 200 : 503).send({
      data: { status: dbOk ? 'ok' : 'degraded', database: dbOk },
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // ---- Public routes: no auth ---------------------------------------------
  await app.register(registerPublicModule, { prefix: '/v1/public' });

  // ---- Authenticated routes -----------------------------------------------
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', makeAuthMiddleware(opts.verifier));

    await scoped.register(registerOptionsModule);
    await scoped.register(registerEntriesModule);
    await scoped.register(registerDrawModule);
    await scoped.register(registerResultsModule);
    await scoped.register(registerRodeosModule);
    await scoped.register(registerDeskModule);
    await scoped.register(registerArenaModule);
    await scoped.register(registerDaySheetModule);
    await scoped.register(registerBooksModule);
    await scoped.register(registerSanctionModule);
    await scoped.register(registerRecordModule);
    await scoped.register(registerScoringModule);
    await scoped.register(registerPayoutsModule);
    await scoped.register(registerSyncModule);
  }, { prefix: '/v1/orgs/:org_id' });

  return app;
}
