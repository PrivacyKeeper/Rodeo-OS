/**
 * Process entry point.
 *
 * Architecture ref: §7.1 — the API runs on Fly.io in `den` (Denver), closest
 * to the rodeo belt, with `dfw` as secondary.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

import { buildApp } from './app.ts';
import type { JWTPayload, TokenVerifier } from './core/auth.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/**
 * Verifies access tokens against Supabase's published JWKS. Asymmetric
 * verification means this process never holds a signing secret it could leak.
 */
function makeSupabaseVerifier(): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(required('SUPABASE_JWKS_URL')));

  return {
    async verify(token: string): Promise<JWTPayload> {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `${required('SUPABASE_URL')}/auth/v1`,
        audience: 'authenticated',
      });
      return payload as unknown as JWTPayload;
    },
  };
}

const app = await buildApp({ verifier: makeSupabaseVerifier() });

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });

// Fly.io sends SIGTERM before replacing an instance. Draining matters here:
// an in-flight payout disbursement must not be cut mid-request.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error(err, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
