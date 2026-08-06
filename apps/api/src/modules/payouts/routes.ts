/**
 * Payout module routes.
 *
 * Architecture ref: §4.1 "RESULTS & PAYOUTS", §6.
 *
 * Calculation and disbursement are separate endpoints on purpose. A producer
 * looks at the numbers before money leaves the account, and the calculation is
 * idempotent so they can re-run it as many times as they like without side
 * effects.
 */

import type { FastifyPluginAsync } from 'fastify';

import {
  calculateMultiRoundPayout,
  calculatePayout,
  formatCents,
  type PayoutConfig,
  type PayoutResult,
} from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';

export const registerPayoutsModule: FastifyPluginAsync = async (fastify) => {
  /**
   * POST .../events/:event_id/calculate-payouts
   *
   * Returns the full breakdown without writing a ledger row. Safe to call
   * repeatedly.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Body: { payout_config_id?: string; dry_run?: boolean };
  }>(
    '/rodeos/:rodeo_id/events/:event_id/calculate-payouts',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            payout_config_id: { type: 'string', format: 'uuid' },
            dry_run: { type: 'boolean', default: true },
          },
        },
      },
      preHandler: requirePermission('payout.calculate'),
    },
    async (request, reply) => {
      const { org_id, event_id } = request.params;

      const ctx = await loadPayoutContext(fastify, org_id, event_id, request.body.payout_config_id);

      const result: PayoutResult = ctx.config.go_round_average_split
        ? calculateMultiRoundPayout({
            payout_config: ctx.config,
            scoring_mode: ctx.scoring_mode,
            entries: ctx.entries,
            added_money_cents: ctx.added_money_cents,
            entry_fee_cents: ctx.entry_fee_cents,
            results_by_round: ctx.results_by_round,
            average_results: ctx.average_results,
          })
        : calculatePayout({
            payout_config: ctx.config,
            scoring_mode: ctx.scoring_mode,
            entries: ctx.entries,
            added_money_cents: ctx.added_money_cents,
            entry_fee_cents: ctx.entry_fee_cents,
            results: ctx.results,
          });

      if (!result.ok) {
        return reply.status(422).send({
          error: {
            code: 'PAYOUT_CALCULATION_FAILED',
            message: 'The payout could not be calculated.',
            details: { issues: result.issues },
          },
          meta: { request_id: request.id },
        });
      }

      // A reconciliation failure here is a bug, not a user error. Refuse to
      // return numbers that do not add up rather than let a producer disburse
      // them. §7.4 tracks this with a target of zero.
      const disbursed = result.payouts.reduce((s, p) => s + p.amount_cents, 0);
      const accounted = disbursed + result.unpaid_cents + result.escrow_cents;
      if (accounted !== result.net_purse_cents) {
        request.log.error(
          { org_id, event_id, accounted, net: result.net_purse_cents },
          'payout does not reconcile',
        );
        return reply.status(500).send({
          error: {
            code: 'PAYOUT_DOES_NOT_RECONCILE',
            message: 'Internal payout reconciliation failed; nothing was written.',
          },
          meta: { request_id: request.id },
        });
      }

      fastify.eventBus.emit('payout.calculated', {
        org_id,
        rodeo_event_id: event_id,
        net_purse_cents: result.net_purse_cents,
        lines: result.payouts.length,
      });

      return reply.send({
        data: {
          ...result,
          display: {
            gross_purse: formatCents(result.gross_purse_cents),
            fees: formatCents(result.fees.total_cents),
            net_purse: formatCents(result.net_purse_cents),
            payouts: result.payouts.map((p) => ({
              ...p,
              amount: formatCents(p.amount_cents),
            })),
          },
        },
        meta: { request_id: request.id, timestamp: new Date().toISOString() },
      });
    },
  );

  /**
   * POST .../payouts/disburse
   *
   * Writes ledger rows and moves money via Stripe Connect. Restricted to
   * owner/admin, and idempotent on the supplied key so a retried request after
   * a network timeout cannot pay twice.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: { idempotency_key: string; confirm: boolean };
  }>(
    '/rodeos/:rodeo_id/payouts/disburse',
    {
      schema: {
        body: {
          type: 'object',
          required: ['idempotency_key', 'confirm'],
          additionalProperties: false,
          properties: {
            idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
            confirm: { type: 'boolean', const: true },
          },
        },
      },
      preHandler: requirePermission('payout.disburse'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;
      const out = await disburse(
        fastify,
        org_id,
        rodeo_id,
        request.body.idempotency_key,
        request.auth!.user.user_id,
      );

      return reply.send({
        data: out,
        meta: { request_id: request.id },
      });
    },
  );
};

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

interface PayoutContext {
  config: PayoutConfig;
  scoring_mode: 'judged' | 'timed';
  entries: { contestant_id: string; status: string; entry_fee_cents?: number }[];
  results: { contestant_id: string; status: string; final_score?: number | null; final_time?: number | null }[];
  results_by_round: Map<number, PayoutContext['results']>;
  average_results: PayoutContext['results'];
  added_money_cents: number;
  entry_fee_cents: number;
}

async function loadPayoutContext(
  _fastify: unknown,
  _orgId: string,
  _eventId: string,
  _configId?: string,
): Promise<PayoutContext> {
  throw new Error('not implemented: wire to core/database');
}

async function disburse(
  _fastify: unknown,
  _orgId: string,
  _rodeoId: string,
  _idempotencyKey: string,
  _actorId: string,
): Promise<unknown> {
  throw new Error('not implemented: wire to integrations/stripe');
}
