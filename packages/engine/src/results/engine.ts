/**
 * Turning scores into results.
 *
 * This is the step between "the run happened" and "here is who won and what
 * they get". Everything downstream reads it: the payout engine's average, the
 * public results page, season standings, and the producer's settlement.
 *
 * It is derived data, entirely. Nothing here is authored by a human — feed it
 * the same scores twice and it produces the same results twice, which is what
 * lets an event be re-finalised after a correction without anybody wondering
 * whether the second run means something different from the first.
 */

import { calculateAggregate } from '../scoring/aggregate.ts';
import { assignDDivisions } from '../scoring/aggregate.ts';
import { rankResults } from '../scoring/rank.ts';
import type {
  DFormatConfig,
  Rankable,
  ScoringConfig,
  ScoringMode,
  ValidationIssue,
} from '../types/index.ts';

export type ResultType =
  | 'go_round'
  | 'average'
  | 'aggregate'
  | 'd_division'
  | 'day_money'
  | 'overall';

export interface ScoreRow {
  contestant_id: string;
  /** For team events, the entry the team competed on. */
  entry_id?: string;
  team_members?: string[];
  go_round: number;
  status: string;
  final_score?: number | null;
  final_time?: number | null;
}

export interface ComputedResult {
  contestant_id: string;
  result_type: ResultType;
  go_round: number | null;
  d_division: number | null;
  aggregate_score: number | null;
  place: number;
  tied_with: string[];
  points_earned: number;
  /** Present for team events so the writer can fan a placing out to the ends. */
  team_members?: string[];
}

/**
 * How a placing converts to season points.
 *
 * PRCA world standings are money — a dollar won is a point. Youth and high
 * school associations award points by placing instead, so both are supported
 * and neither is hard-coded.
 */
export interface PointsConfig {
  basis: 'money' | 'placing' | 'none';
  /** basis 'placing': points for 1st, 2nd, 3rd... Places beyond the list get 0. */
  placing_points?: number[];
  /** Only these result types earn points. Default: go_round and average. */
  counts?: ResultType[];
}

export interface ComputeResultsInput {
  scores: ScoreRow[];
  scoring_config: ScoringConfig;
  num_go_rounds: number;
  /** Set for barrel racing and pole bending. */
  d_format?: DFormatConfig | null;
  points?: PointsConfig;
  /**
   * Money won per contestant, needed when points are money-based. Supplied
   * after the payout runs; absent on a first pass, which simply yields zero
   * points until the payout exists.
   */
  earnings_cents?: Map<string, number>;
}

export interface ComputeResultsOutput {
  results: ComputedResult[];
  issues: ValidationIssue[];
}

const DEFAULT_COUNTS: ResultType[] = ['go_round', 'average'];

function pointsFor(
  place: number,
  resultType: ResultType,
  contestantId: string,
  config: PointsConfig | undefined,
  earnings: Map<string, number> | undefined,
): number {
  if (!config || config.basis === 'none') return 0;
  const counts = config.counts ?? DEFAULT_COUNTS;
  if (!counts.includes(resultType)) return 0;

  if (config.basis === 'money') {
    // A dollar is a point, as in the PRCA world standings.
    return Math.round((earnings?.get(contestantId) ?? 0) / 100);
  }

  const table = config.placing_points ?? [];
  return place >= 1 && place <= table.length ? table[place - 1] : 0;
}

/**
 * Compute every result row for one event.
 *
 * Produces, in order:
 *   - one `go_round` row per contestant per round they placed in
 *   - one `average` row per contestant with a qualified run in EVERY round
 *   - `d_division` rows instead of an average for a D-format event
 *
 * A single-round event still gets `go_round` rows; the average is only
 * meaningful over two or more.
 */
export function computeResults(
  input: ComputeResultsInput,
): ComputeResultsOutput {
  const issues: ValidationIssue[] = [];
  const results: ComputedResult[] = [];
  const mode: ScoringMode = input.scoring_config.mode;

  // Team events place the ENTRY, so carry the members along for the writer.
  const membersOf = new Map<string, string[]>();
  for (const s of input.scores) {
    if (s.team_members?.length) membersOf.set(s.contestant_id, s.team_members);
  }

  const toRankable = (s: ScoreRow): Rankable => ({
    contestant_id: s.contestant_id,
    status: s.status as Rankable['status'],
    final_score: s.final_score ?? null,
    final_time: s.final_time ?? null,
    team_members: s.team_members,
  });

  // ---- Go-rounds ---------------------------------------------------------
  const byRound = new Map<number, ScoreRow[]>();
  for (const s of input.scores) {
    const b = byRound.get(s.go_round) ?? [];
    b.push(s);
    byRound.set(s.go_round, b);
  }

  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const ranked = rankResults(
      byRound.get(round)!.map(toRankable),
      input.scoring_config,
    );
    for (const r of ranked) {
      results.push({
        contestant_id: r.contestant_id,
        result_type: 'go_round',
        go_round: round,
        d_division: null,
        aggregate_score: r.ranked_value,
        place: r.place,
        tied_with: r.tied_with,
        points_earned: pointsFor(
          r.place,
          'go_round',
          r.contestant_id,
          input.points,
          input.earnings_cents,
        ),
        team_members: membersOf.get(r.contestant_id),
      });
    }
  }

  // ---- D-format: divisions instead of an average -------------------------
  if (input.d_format) {
    const finalRound = Math.max(...byRound.keys());
    const field = (byRound.get(finalRound) ?? []).map(toRankable);
    const { assignments, error } = assignDDivisions(field, input.d_format);

    if (error) {
      issues.push({
        field: 'd_format',
        code: 'INVALID_D_CONFIG',
        severity: 'error',
        message: error,
      });
      return { results, issues };
    }

    const byDivision = new Map<number, Rankable[]>();
    for (const a of assignments) {
      const b = byDivision.get(a.division) ?? [];
      b.push({
        contestant_id: a.contestant_id,
        status: 'official',
        final_time: a.final_time,
        final_score: null,
        team_members: membersOf.get(a.contestant_id),
      });
      byDivision.set(a.division, b);
    }

    for (const [division, entrants] of [...byDivision.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      const ranked = rankResults(entrants, input.scoring_config);
      for (const r of ranked) {
        results.push({
          contestant_id: r.contestant_id,
          result_type: 'd_division',
          go_round: null,
          d_division: division,
          aggregate_score: r.ranked_value,
          place: r.place,
          tied_with: r.tied_with,
          points_earned: pointsFor(
            r.place,
            'd_division',
            r.contestant_id,
            input.points,
            input.earnings_cents,
          ),
          team_members: membersOf.get(r.contestant_id),
        });
      }
    }

    return { results, issues };
  }

  // ---- Average -----------------------------------------------------------
  // Only meaningful over more than one round, and only for contestants with a
  // qualified run in every one of them.
  if (input.num_go_rounds > 1) {
    const byContestant = new Map<string, ScoreRow[]>();
    for (const s of input.scores) {
      const b = byContestant.get(s.contestant_id) ?? [];
      b.push(s);
      byContestant.set(s.contestant_id, b);
    }

    const complete: Rankable[] = [];
    for (const [contestantId, rows] of byContestant) {
      const agg = calculateAggregate(
        rows.map((r) => ({
          contestant_id: contestantId,
          go_round: r.go_round,
          status: r.status,
          final_score: r.final_score,
          final_time: r.final_time,
        })),
        input.scoring_config,
        input.num_go_rounds,
      );
      if (!agg?.complete) continue;

      complete.push({
        contestant_id: contestantId,
        status: 'official',
        final_score: mode === 'judged' ? agg.aggregate_value : null,
        final_time: mode === 'timed' ? agg.aggregate_value : null,
        team_members: membersOf.get(contestantId),
      });
    }

    const ranked = rankResults(complete, input.scoring_config);
    for (const r of ranked) {
      results.push({
        contestant_id: r.contestant_id,
        result_type: 'average',
        go_round: null,
        d_division: null,
        aggregate_score: r.ranked_value,
        place: r.place,
        tied_with: r.tied_with,
        points_earned: pointsFor(
          r.place,
          'average',
          r.contestant_id,
          input.points,
          input.earnings_cents,
        ),
        team_members: membersOf.get(r.contestant_id),
      });
    }
  }

  return { results, issues };
}

/**
 * Fan a team's placing out to the people on it.
 *
 * A team places once, but the standings track individuals — headers and
 * heelers carry separate world standings, and a `results` row addressed to an
 * entry id is not addressed to anybody who can be paid or ranked.
 */
export function expandTeamResults(
  results: ComputedResult[],
): ComputedResult[] {
  return results.flatMap((r) =>
    r.team_members?.length
      ? r.team_members.map((memberId) => ({
          ...r,
          contestant_id: memberId,
          team_members: undefined,
        }))
      : [r],
  );
}
