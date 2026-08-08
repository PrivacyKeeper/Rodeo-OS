/**
 * Authentication and authorisation.
 *
 * Architecture ref: §4.2.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED FROM §4.2, AND WHY
 * ---------------------------------------------------------------------------
 * The reference middleware ends with:
 *
 *     await req.db.raw(`SET LOCAL app.current_org_id = '${orgId}'`);
 *
 * `orgId` is `req.params.org_id` — a path segment, straight from the client,
 * concatenated into SQL. A request to
 *
 *     /v1/orgs/x'; SET ROLE postgres; --/rodeos
 *
 * executes whatever the attacker put after the quote. It is the textbook
 * injection, in the one middleware every authenticated request passes through.
 *
 * It is also the wrong mechanism even when parameterised: a session variable
 * the application sets is a claim the application is making about itself, and
 * RLS exists precisely so the database does not have to take the application's
 * word for who is asking. See supabase/migrations/0008_rls.sql for the full
 * argument and the replacement.
 *
 * Here: the JWT is verified against Supabase's JWKS, membership is read from
 * the verified claims, and the database connection carries the caller's own
 * token so `auth.uid()` — and therefore every RLS policy — resolves to the
 * real user. Nothing is interpolated into SQL anywhere.
 * ---------------------------------------------------------------------------
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

export interface OrgMembership {
  org_id: string;
  role: string;
  permissions: string[];
}

export interface AuthenticatedUser {
  /** Supabase Auth subject. */
  auth_id: string;
  /** RodeoApps users.id. */
  user_id: string;
  email: string;
  org_memberships: OrgMembership[];
}

export interface RequestAuth {
  user: AuthenticatedUser;
  org: OrgMembership;
  /** The caller's raw access token, forwarded to PostgREST so RLS applies. */
  access_token: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: RequestAuth;
  }
}

// ---------------------------------------------------------------------------
// Permission matrix (§4.2)
// ---------------------------------------------------------------------------

export const PERMISSIONS = {
  'rodeo.create': ['owner', 'admin'],
  'rodeo.edit': ['owner', 'admin', 'secretary'],
  'rodeo.publish': ['owner', 'admin'],
  'entry.manage': ['owner', 'admin', 'secretary'],
  'draw.generate': ['owner', 'admin', 'secretary'],
  'score.submit': ['owner', 'admin', 'secretary', 'judge', 'timer_operator'],
  'score.correct': ['owner', 'admin', 'secretary'],
  'score.dq': ['owner', 'admin', 'secretary', 'judge'],
  'payout.calculate': ['owner', 'admin', 'secretary'],
  'payout.disburse': ['owner', 'admin'],
  'financial.view': ['owner', 'admin', 'secretary'],
  'stock.manage': ['owner', 'admin', 'secretary', 'stock_contractor'],
  'waiver.manage': ['owner', 'admin', 'secretary'],
  // Closing the books is the secretary's job by definition — she is the one
  // sitting in the office at eleven at night with the deadline on her.
  'books.close': ['owner', 'admin', 'secretary'],
  // Reopening reverses a filed set of books. Narrower on purpose.
  'books.reopen': ['owner', 'admin'],
  'compliance.manage': ['owner', 'admin', 'secretary'],
  'personnel.manage': ['owner', 'admin', 'secretary'],
  'registry.manage': ['owner', 'admin', 'secretary'],
  // Stalls, RV spots and arena rental — the producer's own income, taken at
  // the same desk by the same person as the entries.
  'booking.manage': ['owner', 'admin', 'secretary'],
  'notice.send': ['owner', 'admin', 'secretary'],
  // The year-end report puts a mailing address next to a dollar total for
  // everybody the producer paid all season. Narrower than 'financial.view'.
  'tax.report': ['owner', 'admin'],
  'contestant.self': ['contestant'],
} as const satisfies Record<string, readonly string[]>;

export type Permission = keyof typeof PERMISSIONS;

export function roleGrants(role: string, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly string[]).includes(role);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

export interface JWTPayload {
  sub: string;
  email?: string;
  exp: number;
  iat: number;
  /**
   * Written by a Supabase Auth custom-access-token hook from org_members.
   * Treated as a cache: it decides which org the request is FOR, but the
   * database still re-derives the membership from auth.uid() when it applies
   * RLS, so a stale or forged claim cannot widen access.
   */
  app_metadata?: {
    user_id?: string;
    org_memberships?: OrgMembership[];
  };
}

export interface TokenVerifier {
  verify(token: string): Promise<JWTPayload>;
}

/**
 * Builds the request hook. `verifier` is injected so the auth path is testable
 * without a live Supabase project.
 */
export function makeAuthMiddleware(verifier: TokenVerifier) {
  return async function authMiddleware(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AuthError(401, 'MISSING_TOKEN', 'Authorization bearer token required.');
    }

    const token = header.slice('Bearer '.length).trim();
    let payload: JWTPayload;
    try {
      payload = await verifier.verify(token);
    } catch {
      throw new AuthError(401, 'INVALID_TOKEN', 'Access token is invalid or expired.');
    }

    const memberships = payload.app_metadata?.org_memberships ?? [];
    const user: AuthenticatedUser = {
      auth_id: payload.sub,
      user_id: payload.app_metadata?.user_id ?? payload.sub,
      email: payload.email ?? '',
      org_memberships: memberships,
    };

    const orgId = (req.params as Record<string, string> | undefined)?.org_id;
    if (!orgId) {
      // Routes outside /orgs/:org_id (e.g. /me) authenticate without an org.
      req.auth = {
        user,
        org: { org_id: '', role: '', permissions: [] },
        access_token: token,
      };
      return;
    }

    // A path parameter must look like a UUID before it goes anywhere near a
    // query. This is belt and braces — nothing below interpolates it — but it
    // turns a malformed request into a 400 instead of a database error.
    if (!isUuid(orgId)) {
      throw new AuthError(400, 'BAD_ORG_ID', 'org_id must be a UUID.');
    }

    const membership = memberships.find((m) => m.org_id === orgId);
    if (!membership) {
      throw new AuthError(
        403,
        'NOT_A_MEMBER',
        'You are not a member of this organization.',
      );
    }

    req.auth = { user, org: membership, access_token: token };
    void reply; // reply is unused; errors propagate to the error handler
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Route-level guard. Use as a preHandler after authMiddleware.
 *
 * This is a fast rejection at the edge; it is not the security boundary. The
 * boundary is RLS, which runs on the caller's own token and cannot be talked
 * out of it.
 */
export function requirePermission(permission: Permission) {
  return async function guard(req: FastifyRequest): Promise<void> {
    const auth = req.auth;
    if (!auth) {
      throw new AuthError(401, 'NOT_AUTHENTICATED', 'Authentication required.');
    }
    if (auth.org.permissions?.includes(permission)) return;
    if (roleGrants(auth.org.role, permission)) return;

    throw new AuthError(
      403,
      'FORBIDDEN',
      `Role '${auth.org.role}' may not perform '${permission}'.`,
    );
  };
}
