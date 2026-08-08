/**
 * The grounds and the business: bookings, notices, releases, and the year-end
 * report.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ROUTES ARE FOR
 * ---------------------------------------------------------------------------
 * Everything else in this API is about the competition. This is about running
 * the place the competition happens in: selling a stall, telling a hundred
 * ropers the draw is up, holding a release on file, and adding up in January
 * what was paid to whom.
 *
 * Two of them carry more risk than the rest of the API put together and are
 * gated accordingly. `/tax-summary` returns a mailing address next to a dollar
 * total for every person a producer paid in a year — owner and admin only.
 * Signing a waiver goes through a database function that computes its own
 * hashes, so no route here can be talked into accepting a hash from a client.
 */

import type { FastifyPluginAsync } from 'fastify';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as grounds from '../../core/database/grounds-repo.ts';

const ISO_DATE = '^\\d{4}-\\d{2}-\\d{2}$';

export const registerGroundsModule: FastifyPluginAsync = async (fastify) => {
  // =========================================================================
  // Resources and availability
  // =========================================================================

  /** GET /resources?rodeo_id= */
  fastify.get<{ Params: { org_id: string }; Querystring: { rodeo_id?: string } }>(
    '/resources',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.listResources(tx, request.params.org_id, request.query.rodeo_id),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  /** POST /resources */
  fastify.post<{
    Params: { org_id: string };
    Body: grounds.NewResource;
  }>(
    '/resources',
    {
      schema: {
        body: {
          type: 'object',
          required: ['resource_type', 'name'],
          additionalProperties: false,
          properties: {
            rodeo_id: { type: 'string', format: 'uuid' },
            resource_type: { type: 'string', minLength: 1, maxLength: 60 },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            description: { type: 'string', maxLength: 2000 },
            capacity: { type: 'integer', minimum: 1, maximum: 10000 },
            price_cents: { type: 'integer', minimum: 0 },
            price_unit: {
              type: 'string',
              enum: ['per_night', 'per_stay', 'per_head'],
            },
            sort_order: { type: 'integer' },
          },
        },
      },
      preHandler: requirePermission('booking.manage'),
    },
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.createResource(tx, request.params.org_id, request.body),
      );
      return reply.status(201).send({ data: row, meta: { request_id: request.id } });
    },
  );

  /**
   * GET /availability?from=&to=&rodeo_id=
   *
   * What is left for those dates, counting bookings that overlap rather than
   * bookings that start on the day — which is the difference between an honest
   * answer and a double-booked barn.
   */
  fastify.get<{
    Params: { org_id: string };
    Querystring: { from: string; to: string; rodeo_id?: string };
  }>(
    '/availability',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['from', 'to'],
          properties: {
            from: { type: 'string', pattern: ISO_DATE },
            to: { type: 'string', pattern: ISO_DATE },
            rodeo_id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const { from, to, rodeo_id } = request.query;
      if (to <= from) {
        return reply.status(400).send({
          error: {
            code: 'BAD_DATE_RANGE',
            message: 'A stay must end after it starts.',
          },
          meta: { request_id: request.id },
        });
      }
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.checkAvailability(tx, request.params.org_id, from, to, rodeo_id),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  // =========================================================================
  // Bookings
  // =========================================================================

  /** GET /bookings?rodeo_id= */
  fastify.get<{ Params: { org_id: string }; Querystring: { rodeo_id?: string } }>(
    '/bookings',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.listBookings(tx, request.params.org_id, request.query.rodeo_id),
      );
      const live = rows.filter(
        (r) => r.status === 'held' || r.status === 'confirmed',
      );
      return reply.send({
        data: rows,
        meta: {
          request_id: request.id,
          live: live.length,
          unpaid: live.filter((r) => !r.paid).length,
          owed_cents: live
            .filter((r) => !r.paid)
            .reduce((sum, r) => sum + r.amount_cents, 0),
        },
      });
    },
  );

  /**
   * POST /bookings
   *
   * A double-booking comes back as 409 rather than 500. The exclusion
   * constraint raises 23P01 and the capacity check raises 23514; both mean the
   * same thing to the person at the desk — it is taken — and both have to be
   * distinguishable from a bug.
   */
  fastify.post<{
    Params: { org_id: string };
    Body: grounds.BookingInput;
  }>(
    '/bookings',
    {
      schema: {
        body: {
          type: 'object',
          required: ['resource_id', 'from', 'to'],
          additionalProperties: false,
          properties: {
            resource_id: { type: 'string', format: 'uuid' },
            from: { type: 'string', pattern: ISO_DATE },
            to: { type: 'string', pattern: ISO_DATE },
            quantity: { type: 'integer', minimum: 1, maximum: 1000 },
            user_id: { type: 'string', format: 'uuid' },
            contact_name: { type: 'string', minLength: 1, maxLength: 200 },
            rodeo_id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: requirePermission('booking.manage'),
    },
    async (request, reply) => {
      const body = request.body;
      if (!body.user_id && !body.contact_name) {
        return reply.status(400).send({
          error: {
            code: 'BOOKING_NEEDS_SOMEBODY',
            message: 'A booking needs either a person or a name.',
          },
          meta: { request_id: request.id },
        });
      }

      try {
        const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
          grounds.bookResource(tx, request.params.org_id, body),
        );
        return reply.status(201).send({ data: row, meta: { request_id: request.id } });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23P01' || code === '23514') {
          return reply.status(409).send({
            error: {
              code: 'ALREADY_BOOKED',
              message: (err as Error).message,
            },
            meta: { request_id: request.id },
          });
        }
        throw err;
      }
    },
  );

  /** POST /bookings/:booking_id/confirm */
  fastify.post<{
    Params: { org_id: string; booking_id: string };
    Body: { payment_reference?: string };
  }>(
    '/bookings/:booking_id/confirm',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { payment_reference: { type: 'string', maxLength: 200 } },
        },
      },
      preHandler: requirePermission('booking.manage'),
    },
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.confirmBooking(
          tx,
          request.params.org_id,
          request.params.booking_id,
          request.body?.payment_reference,
        ),
      );
      if (!row) {
        return reply.status(404).send({
          error: { code: 'BOOKING_NOT_FOUND', message: 'No such live booking.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: row, meta: { request_id: request.id } });
    },
  );

  /** POST /bookings/:booking_id/cancel */
  fastify.post<{
    Params: { org_id: string; booking_id: string };
    Body: { reason: string; refund_cents?: number };
  }>(
    '/bookings/:booking_id/cancel',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 500 },
            refund_cents: { type: 'integer', minimum: 0 },
          },
        },
      },
      preHandler: requirePermission('booking.manage'),
    },
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.cancelBooking(
          tx,
          request.params.org_id,
          request.params.booking_id,
          request.body.reason,
          request.body.refund_cents,
        ),
      );
      if (!row) {
        return reply.status(404).send({
          error: { code: 'BOOKING_NOT_FOUND', message: 'No such open booking.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: row, meta: { request_id: request.id } });
    },
  );

  /**
   * POST /bookings/expire-holds
   *
   * Says what it released. A stall that quietly frees itself is how somebody
   * turns up on Friday to find their spot sold twice.
   */
  fastify.post<{ Params: { org_id: string } }>(
    '/bookings/expire-holds',
    { preHandler: requirePermission('booking.manage') },
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.expireHolds(tx, request.params.org_id),
      );
      return reply.send({
        data: rows,
        meta: { request_id: request.id, released: rows.length },
      });
    },
  );

  // =========================================================================
  // Notices
  // =========================================================================

  /** GET /notices?rodeo_id= — what this org has sent. */
  fastify.get<{ Params: { org_id: string }; Querystring: { rodeo_id?: string } }>(
    '/notices',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.listNotices(tx, request.params.org_id, request.query.rodeo_id),
      );
      return reply.send({
        data: rows,
        meta: {
          request_id: request.id,
          pending: rows.filter((r) => r.status === 'pending').length,
        },
      });
    },
  );

  /** GET /notices/mine — a contestant's own inbox. */
  fastify.get<{ Params: { org_id: string } }>(
    '/notices/mine',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.listMyNotices(tx),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  /** POST /notices */
  fastify.post<{
    Params: { org_id: string };
    Body: {
      notice_type: string;
      user_id: string;
      subject: string;
      body: string;
      rodeo_id?: string;
      channel?: string;
      send_after?: string;
    };
  }>(
    '/notices',
    {
      schema: {
        body: {
          type: 'object',
          required: ['notice_type', 'user_id', 'subject', 'body'],
          additionalProperties: false,
          properties: {
            notice_type: { type: 'string', minLength: 1, maxLength: 60 },
            user_id: { type: 'string', format: 'uuid' },
            subject: { type: 'string', minLength: 1, maxLength: 300 },
            body: { type: 'string', minLength: 1, maxLength: 4000 },
            rodeo_id: { type: 'string', format: 'uuid' },
            channel: { type: 'string', enum: ['email', 'sms', 'push', 'in_app'] },
            send_after: { type: 'string', format: 'date-time' },
          },
        },
      },
      preHandler: requirePermission('notice.send'),
    },
    async (request, reply) => {
      const id = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.queueNotice(tx, request.params.org_id, request.body),
      );
      return reply.status(201).send({
        data: { id },
        meta: { request_id: request.id },
      });
    },
  );

  /**
   * POST /rodeos/:rodeo_id/notices/draw-posted
   *
   * The single most-wanted message in the sport. Idempotent: run it twice and
   * nobody gets told twice, because `notify_draw_posted()` will not write a
   * second row for a contestant who already has one for this rodeo.
   */
  fastify.post<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/notices/draw-posted',
    { preHandler: requirePermission('notice.send') },
    async (request, reply) => {
      const count = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.notifyDrawPosted(tx, request.params.org_id, request.params.rodeo_id),
      );
      return reply.send({
        data: { queued: count },
        meta: { request_id: request.id },
      });
    },
  );

  // =========================================================================
  // Waivers
  // =========================================================================

  /** GET /waivers/templates */
  fastify.get<{ Params: { org_id: string } }>(
    '/waivers/templates',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.listWaiverTemplates(tx, request.params.org_id),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  /**
   * POST /waivers/sign
   *
   * The client sends who signed, how, and what they typed. It never sends a
   * hash — both hashes are computed inside `sign_waiver()` from the template
   * text as stored, which is the only version of it that is evidence.
   */
  fastify.post<{
    Params: { org_id: string };
    Body: {
      template_id: string;
      user_id: string;
      method: string;
      typed_name?: string;
      rodeo_id?: string;
      signature_image_url?: string;
      guardian_user_id?: string;
      guardian_name?: string;
    };
  }>(
    '/waivers/sign',
    {
      schema: {
        body: {
          type: 'object',
          required: ['template_id', 'user_id', 'method'],
          additionalProperties: false,
          properties: {
            template_id: { type: 'string', format: 'uuid' },
            user_id: { type: 'string', format: 'uuid' },
            method: {
              type: 'string',
              enum: [
                'click_to_sign',
                'typed_name',
                'drawn_signature',
                'paper_on_file',
              ],
            },
            typed_name: { type: 'string', minLength: 1, maxLength: 200 },
            rodeo_id: { type: 'string', format: 'uuid' },
            signature_image_url: { type: 'string', maxLength: 2000 },
            guardian_user_id: { type: 'string', format: 'uuid' },
            guardian_name: { type: 'string', maxLength: 200 },
          },
        },
      },
      preHandler: requirePermission('waiver.manage'),
    },
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.signWaiver(tx, request.params.org_id, {
          ...request.body,
          // Taken from the connection, never from the body. A client-supplied
          // IP address in an evidence record is worse than no IP address.
          ip: request.ip,
          user_agent: request.headers['user-agent'] ?? null,
        }),
      );
      return reply.status(201).send({ data: row, meta: { request_id: request.id } });
    },
  );

  /** GET /waivers/:signed_id/verify — recompute the hashes. */
  fastify.get<{ Params: { org_id: string; signed_id: string } }>(
    '/waivers/:signed_id/verify',
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.verifySignedWaiver(tx, request.params.signed_id),
      );
      return reply.send({
        data: row,
        meta: {
          request_id: request.id,
          // A mismatch on the text with no version change is the case worth
          // shouting about: the document moved under a signature.
          suspicious: !row.record_matches
            || (!row.text_matches && !row.template_changed_since),
        },
      });
    },
  );

  /** GET /rodeos/:rodeo_id/waivers/shortfall — who has not signed. */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/waivers/shortfall',
    { preHandler: requirePermission('waiver.manage') },
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.waiverShortfall(tx, request.params.org_id, request.params.rodeo_id),
      );
      const missing = rows.filter((r) => !r.signed);
      return reply.send({
        data: rows,
        meta: {
          request_id: request.id,
          missing: missing.length,
          people_missing: new Set(missing.map((r) => r.contestant_id)).size,
        },
      });
    },
  );

  // =========================================================================
  // Year-end
  // =========================================================================

  /**
   * GET /tax-summary?year=&country=
   *
   * What the accountant needs in January. The response says which threshold it
   * applied and which form it belongs to, because the US figure moved in 2026
   * and is indexed from here on — a producer reading a bare list of totals
   * would have no way to tell which year's rule produced it.
   *
   * This system does not file anything and cannot: it stores the last four
   * digits of a tax identifier and nothing more.
   */
  fastify.get<{
    Params: { org_id: string };
    Querystring: { year?: number; country?: string };
  }>(
    '/tax-summary',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            year: { type: 'integer', minimum: 2000, maximum: 2100 },
            country: { type: 'string', minLength: 2, maxLength: 2 },
          },
        },
      },
      preHandler: requirePermission('tax.report'),
    },
    async (request, reply) => {
      const year = request.query.year ?? new Date().getUTCFullYear() - 1;
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        grounds.taxYearSummary(tx, request.params.org_id, year, request.query.country),
      );
      const reportable = rows.filter((r) => r.reportable);
      return reply.send({
        data: rows,
        meta: {
          request_id: request.id,
          year,
          form: rows[0]?.form ?? null,
          threshold_cents: rows[0]?.threshold_cents ?? null,
          people_paid: rows.length,
          reportable: reportable.length,
          missing_tax_id: rows.filter((r) => r.missing_tax_id).length,
          advisory:
            'Reporting figures only. This system holds no full tax '
            + 'identifiers and files nothing. Confirm the threshold in force '
            + 'for the year with your accountant before filing.',
        },
      });
    },
  );
};
