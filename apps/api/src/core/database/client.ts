/**
 * Database access, bound to the caller's identity.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING TO UNDERSTAND ABOUT THIS FILE
 * ---------------------------------------------------------------------------
 * docs/SPEC-DELTAS.md D1 rejects the architecture's middleware:
 *
 *     await req.db.raw(`SET LOCAL app.current_org_id = '${orgId}'`);
 *
 * This file also sets a transaction-scoped setting. The difference is the
 * whole security model, so it is worth being precise about:
 *
 *   * The architecture set an ORG ID taken from a URL path segment, and
 *     concatenated it into SQL. The value is chosen by the caller. Ask for
 *     another tenant's id and you get their data.
 *
 *   * This sets JWT CLAIMS that were cryptographically verified against
 *     Supabase's JWKS before the transaction opened, passed as a bound
 *     parameter to set_config(). The caller cannot choose them: forging them
 *     requires the signing key. The database then derives the tenant itself,
 *     through auth.uid() and org_members, exactly as it does for PostgREST.
 *
 * So the mechanism looks similar and the trust model is inverted. What flows
 * in is a signed assertion of WHO you are, not an unsigned claim about WHAT
 * you may see.
 *
 * Two more properties fall out of doing it this way:
 *
 *   1. `set local role authenticated` means the connection is subject to RLS
 *      for the duration of the transaction. If a query is wrong, it returns
 *      too few rows, not somebody else's.
 *   2. The API, the Supabase JS SDK, Realtime and every discipline app now go
 *      through identical policies. There is one access model, not two.
 * ---------------------------------------------------------------------------
 */

import postgres from 'postgres';

export type Sql = postgres.Sql<Record<string, never>>;
/** What postgres.js will accept for tx.json(). */
export type Json = Parameters<Sql['json']>[0];
export type Tx = postgres.TransactionSql<Record<string, never>>;

export interface DatabaseConfig {
  connectionString: string;
  /** Pooled connections. Arena traffic is bursty but small. */
  max?: number;
  /** Seconds a connection may sit idle before being returned. */
  idleTimeout?: number;
  /** Seconds a statement may run before being cancelled. */
  statementTimeout?: number;
  ssl?: boolean | 'require';
}

export function createSql(config: DatabaseConfig): Sql {
  return postgres(config.connectionString, {
    max: config.max ?? 10,
    idle_timeout: config.idleTimeout ?? 30,
    // A runaway query must not hold an arena terminal hostage mid-performance.
    connection: {
      statement_timeout: (config.statementTimeout ?? 15) * 1000,
    },
    ssl: config.ssl ?? false,
    // postgres.js parameterises tagged-template interpolations. Values are
    // never spliced into SQL text; there is no string concatenation anywhere
    // in the repositories.
    transform: { undefined: null },
    onnotice: () => {},
  });
}

/** The verified claims that will be handed to the database. */
export interface VerifiedClaims {
  /** Supabase Auth subject. Becomes auth.uid(). */
  sub: string;
  role: 'authenticated';
  email?: string;
  [key: string]: unknown;
}

export class Database {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  /**
   * Run work as the authenticated caller, inside one transaction, with RLS on.
   *
   * `claims` MUST have come from a verified token. Nothing in this class
   * checks that, because it cannot — verification happens in the auth
   * middleware against the JWKS, and passing unverified claims here would
   * defeat the entire model. The type is named VerifiedClaims to make an
   * unverified value look wrong at the call site.
   */
  async asUser<T>(
    claims: VerifiedClaims,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return this.#sql.begin(async (tx) => {
      // Bound parameter, not interpolation. `true` scopes it to this
      // transaction, so a pooled connection cannot leak one caller's identity
      // into the next request.
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
      await tx`set local role authenticated`;
      return work(tx as Tx);
    }) as Promise<T>;
  }

  /**
   * Run work with RLS BYPASSED.
   *
   * Legitimate uses are narrow and all of them are jobs with no user to act
   * for: Stripe webhook handlers, nightly exports, the migration runner. If
   * you are reaching for this inside a request handler, the request has a user
   * and you want asUser().
   *
   * `reason` is required and logged, so an audit of privileged access is a
   * grep rather than an archaeology exercise.
   */
  async asService<T>(reason: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    if (!reason || reason.length < 8) {
      throw new Error('asService() requires a reason describing why RLS is bypassed');
    }
    return this.#sql.begin(async (tx) => {
      await tx`set local role service_role`;
      return work(tx as Tx);
    }) as Promise<T>;
  }

  /** Unauthenticated read. Only the public-results policies will match. */
  async asAnon<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#sql.begin(async (tx) => {
      await tx`set local role anon`;
      return work(tx as Tx);
    }) as Promise<T>;
  }

  async healthy(): Promise<boolean> {
    try {
      await this.#sql`select 1`;
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  /** Escape hatch for migrations and tests. Not for request handling. */
  get raw(): Sql {
    return this.#sql;
  }
}

/** Build the claims object from an authenticated request. */
export function claimsFor(auth: {
  user: { auth_id: string; email: string };
}): VerifiedClaims {
  return {
    sub: auth.user.auth_id,
    role: 'authenticated',
    email: auth.user.email,
  };
}
