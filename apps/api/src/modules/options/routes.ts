/**
 * Options API — every dropdown in the product reads from here.
 *
 * One endpoint per domain, plus a bulk fetch so a form that needs eight
 * dropdowns makes one request instead of eight. Options change rarely, so
 * responses are cached hard at the edge and busted by the producer's own
 * mutation.
 *
 * The point of this module: a producer never files a support ticket asking for
 * an event type to be added. They add it themselves, and it appears in their
 * dropdowns and nobody else's.
 */

import type { FastifyPluginAsync } from 'fastify';

import { requirePermission } from '../../core/auth.ts';

/**
 * The domains the product exposes. Kept as a closed list here even though the
 * table would accept anything, so a typo in a URL is a 404 rather than a
 * silently empty dropdown.
 */
export const OPTION_DOMAINS = [
  'event_type',
  'org_role',
  'rodeo_type',
  'sanctioning_body',
  'fee_type',
  'penalty_type',
  'dq_reason',
  'catch_type',
  'draw_method',
  'entry_method',
  'timer_system',
  'animal_type',
  'release_reason',
  'payout_structure',
  'payment_method',
  'module',
] as const;

export type OptionDomain = (typeof OPTION_DOMAINS)[number];

export interface ReferenceOption {
  code: string;
  label: string;
  description: string | null;
  category: string | null;
  sort_order: number;
  metadata: Record<string, unknown>;
  /** False for system options — the UI hides edit and delete on those. */
  is_custom: boolean;
}

/** Dropdowns render grouped by category, in sort order. */
export interface OptionGroup {
  category: string | null;
  options: ReferenceOption[];
}

function group(options: ReferenceOption[]): OptionGroup[] {
  const byCategory = new Map<string | null, ReferenceOption[]>();
  for (const option of options) {
    const bucket = byCategory.get(option.category) ?? [];
    bucket.push(option);
    byCategory.set(option.category, bucket);
  }
  return [...byCategory.entries()]
    .map(([category, opts]) => ({
      category,
      options: opts.sort((a, b) => a.sort_order - b.sort_order),
    }))
    .sort(
      (a, b) => (a.options[0]?.sort_order ?? 0) - (b.options[0]?.sort_order ?? 0),
    );
}

export const registerOptionsModule: FastifyPluginAsync = async (fastify) => {
  /** GET /v1/orgs/:org_id/options — every domain at once. */
  fastify.get<{ Params: { org_id: string } }>(
    '/options',
    async (request, reply) => {
      const all = await loadAllOptions(fastify, request.params.org_id);

      const grouped: Record<string, OptionGroup[]> = {};
      for (const domain of OPTION_DOMAINS) {
        grouped[domain] = group(all.filter((o) => o.domain === domain));
      }

      reply.header('cache-control', 'private, max-age=60');
      return reply.send({
        data: grouped,
        meta: { request_id: request.id, domains: OPTION_DOMAINS.length },
      });
    },
  );

  /** GET /v1/orgs/:org_id/options/:domain */
  fastify.get<{ Params: { org_id: string; domain: string } }>(
    '/options/:domain',
    async (request, reply) => {
      const { org_id, domain } = request.params;

      if (!(OPTION_DOMAINS as readonly string[]).includes(domain)) {
        return reply.status(404).send({
          error: {
            code: 'UNKNOWN_OPTION_DOMAIN',
            message: `'${domain}' is not an option domain.`,
            details: { valid_domains: OPTION_DOMAINS },
          },
          meta: { request_id: request.id },
        });
      }

      const options = await loadOptions(fastify, org_id, domain);

      reply.header('cache-control', 'private, max-age=60');
      return reply.send({
        data: { domain, groups: group(options), flat: options },
        meta: { request_id: request.id },
      });
    },
  );

  /**
   * POST /v1/orgs/:org_id/options/:domain
   *
   * A producer adding an option of their own. System options are not editable
   * through this route at all — there is no code path here that writes a row
   * with org_id null.
   */
  fastify.post<{
    Params: { org_id: string; domain: string };
    Body: {
      code: string;
      label: string;
      description?: string;
      category?: string;
      sort_order?: number;
      metadata?: Record<string, unknown>;
    };
  }>(
    '/options/:domain',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code', 'label'],
          additionalProperties: false,
          properties: {
            // Machine value: lowercase, digits and underscores. It ends up in
            // exports, feeds and URLs, so it is not free text.
            code: {
              type: 'string',
              pattern: '^[a-z][a-z0-9_]{1,47}$',
              maxLength: 48,
            },
            label: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string', maxLength: 500 },
            category: { type: 'string', maxLength: 60 },
            sort_order: { type: 'integer', minimum: 0, maximum: 100000 },
            metadata: { type: 'object' },
          },
        },
      },
      preHandler: requirePermission('rodeo.edit'),
    },
    async (request, reply) => {
      const { org_id, domain } = request.params;

      if (!(OPTION_DOMAINS as readonly string[]).includes(domain)) {
        return reply.status(404).send({
          error: {
            code: 'UNKNOWN_OPTION_DOMAIN',
            message: `'${domain}' is not an option domain.`,
          },
          meta: { request_id: request.id },
        });
      }

      const created = await createOption(fastify, org_id, domain, request.body);

      return reply.status(201).send({
        data: created,
        meta: { request_id: request.id },
      });
    },
  );

  /**
   * PATCH /v1/orgs/:org_id/options/:domain/:code
   *
   * Producers deactivate options they never use rather than deleting them —
   * a rodeo from three seasons ago still references the event type it ran.
   */
  fastify.patch<{
    Params: { org_id: string; domain: string; code: string };
    Body: { label?: string; is_active?: boolean; sort_order?: number };
  }>(
    '/options/:domain/:code',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', minLength: 1, maxLength: 120 },
            is_active: { type: 'boolean' },
            sort_order: { type: 'integer', minimum: 0, maximum: 100000 },
          },
        },
      },
      preHandler: requirePermission('rodeo.edit'),
    },
    async (request, reply) => {
      const { org_id, domain, code } = request.params;
      const updated = await updateOption(
        fastify,
        org_id,
        domain,
        code,
        request.body,
      );

      if (!updated) {
        return reply.status(404).send({
          error: {
            code: 'OPTION_NOT_FOUND',
            message:
              `No option '${code}' in '${domain}' belonging to this ` +
              `organization. System options cannot be edited, only hidden.`,
          },
          meta: { request_id: request.id },
        });
      }

      return reply.send({ data: updated, meta: { request_id: request.id } });
    },
  );
};

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

type StoredOption = ReferenceOption & { domain: string };

async function loadAllOptions(
  _fastify: unknown,
  _orgId: string,
): Promise<StoredOption[]> {
  throw new Error('not implemented: wire to core/database');
}

async function loadOptions(
  _fastify: unknown,
  _orgId: string,
  _domain: string,
): Promise<ReferenceOption[]> {
  throw new Error('not implemented: wire to core/database');
}

async function createOption(
  _fastify: unknown,
  _orgId: string,
  _domain: string,
  _body: unknown,
): Promise<ReferenceOption> {
  throw new Error('not implemented: wire to core/database');
}

async function updateOption(
  _fastify: unknown,
  _orgId: string,
  _domain: string,
  _code: string,
  _body: unknown,
): Promise<ReferenceOption | null> {
  throw new Error('not implemented: wire to core/database');
}
