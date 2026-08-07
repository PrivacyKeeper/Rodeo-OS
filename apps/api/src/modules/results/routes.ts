/**
 * Finalising an event.
 *
 * Architecture ref: §4.1 `/finalize`.
 *
 * This is the step everything downstream depends on, and the one that was
 * missing: three places read `results` and nothing wrote it, so the average
 * payout paid nobody, the public results page was blank, and season standings
 * returned an empty list. See docs/SPEC-DELTAS.md D29.
 *
 * Results are DERIVED. Finalising twice recomputes from the scores and
 * replaces what was there — which is what makes correcting a run safe: fix
 * the score, finalise again, and the placings, the average and the points all
 * move together.
 */

import type { FastifyPluginAsync } from 'fastify';

import {
  computeResults,
  expandTeamResults,
  type PointsConfig,
  type ScoringConfig,
} from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as repo from '../../core/database/entries-repo.ts';

export const registerResultsModule: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Body: { official?: boolean; points?: PointsConfig };
  }>(
    '/rodeos/:rodeo_id/events/:event_id/finalize',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // Provisional by default. A secretary looks at the placings before
            // they become the thing contestants and the public are told.
            official: { type: 'boolean', default: false },
            points: {
              type: 'object',
              additionalProperties: false,
              properties: {
                basis: { type: 'string', enum: ['money', 'placing', 'none'] },
                placing_points: {
                  type: 'array',
                  maxItems: 50,
                  items: { type: 'number', minimum: 0 },
                },
                counts: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      preHandler: requirePermission('score.correct'),
    },
    async (request, reply) => {
      const { org_id, event_id } = request.params;
      const official = request.body?.official ?? false;
      const claims = claimsFor(request.auth!);

      const out = await fastify.db.asUser(claims, async (tx) => {
        const event = await repo.loadEventForResults(tx, org_id, event_id);
        if (!event) return { kind: 'not_found' as const };

        const payoutConfig = event.payout_config as { team_payout?: string } | null;
        const isTeamEvent = payoutConfig?.team_payout !== undefined;

        const scores = await repo.loadScoresForResults(
          tx,
          org_id,
          event_id,
          isTeamEvent,
        );
        if (scores.length === 0) return { kind: 'no_scores' as const };

        // Money-based points need what has already been paid. On a first pass
        // there is no payout yet and the points are zero — finalise again
        // after disbursement to credit them.
        const earnings =
          request.body?.points?.basis === 'money'
            ? await repo.loadEarnings(tx, org_id, event_id)
            : undefined;

        const computed = computeResults({
          scores: scores.map((s) => ({
            contestant_id: s.contestant_id,
            entry_id: s.entry_id,
            team_members: s.team_members ?? undefined,
            go_round: s.go_round,
            status: s.status,
            final_score: s.final_score,
            final_time: s.final_time,
          })),
          scoring_config:
            (event.scoring_config as ScoringConfig | null) ?? {
              mode: event.scoring_mode,
            },
          num_go_rounds: event.num_go_rounds,
          d_format: event.is_d_format ? (event.d_format_config as never) : null,
          points: request.body?.points,
          earnings_cents: earnings,
        });

        if (computed.issues.some((i) => i.severity === 'error')) {
          return { kind: 'failed' as const, issues: computed.issues };
        }

        // A team places once; the standings track individuals. Fan the placing
        // out to the ends before writing, or the rows name an entry id that no
        // contestant can be found under.
        const rows = expandTeamResults(computed.results);

        const written = await repo.writeResults(tx, {
          org_id,
          rodeo_id: event.rodeo_id,
          rodeo_event_id: event_id,
          results: rows.map((r) => ({
            contestant_id: r.contestant_id,
            result_type: r.result_type,
            go_round: r.go_round,
            d_division: r.d_division,
            aggregate_score: r.aggregate_score,
            place: r.place,
            tied_with: r.tied_with,
            points_earned: r.points_earned,
          })),
          official,
        });

        return {
          kind: 'ok' as const,
          written,
          official,
          summary: summarise(rows),
          warnings: computed.issues.filter((i) => i.severity === 'warning'),
        };
      });

      if (out.kind === 'not_found') {
        return reply.status(404).send({
          error: { code: 'EVENT_NOT_FOUND', message: 'No such event.' },
          meta: { request_id: request.id },
        });
      }
      if (out.kind === 'no_scores') {
        return reply.status(422).send({
          error: {
            code: 'NO_SCORES',
            message: 'Nothing has been scored in this event yet.',
          },
          meta: { request_id: request.id },
        });
      }
      if (out.kind === 'failed') {
        return reply.status(422).send({
          error: {
            code: 'RESULTS_FAILED',
            message: 'Results could not be computed; nothing was written.',
            details: { issues: out.issues },
          },
          meta: { request_id: request.id },
        });
      }

      if (official) {
        fastify.eventBus.emit('results.official', {
          org_id,
          rodeo_event_id: event_id,
        });
      }

      return reply.send({ data: out, meta: { request_id: request.id } });
    },
  );
};

function summarise(rows: { result_type: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.result_type] = (counts[r.result_type] ?? 0) + 1;
  return counts;
}
