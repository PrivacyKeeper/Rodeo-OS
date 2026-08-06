/**
 * Multi-round aggregation ("the average") and D-format division assignment.
 *
 * Architecture ref: §5.5, §5.6.
 */

import type {
  AggregateResult,
  DFormatConfig,
  Rankable,
  ScoringConfig,
} from '../types/index.ts';

export interface RoundScore {
  contestant_id: string;
  go_round: number;
  status: string;
  final_score?: number | null;
  final_time?: number | null;
}

/**
 * Aggregate one contestant's rounds into an average standing.
 *
 * A contestant only places in the average if they have a qualified run in
 * EVERY round. §5.5 checks `completedRounds.length < numRounds`, which is the
 * right idea, but it counts only rounds present in the map — a contestant who
 * caught in round 1 and missed in round 2 has a 'no_time' row that is filtered
 * out, leaving one entry and, if numRounds were miscounted, a bogus average on
 * a single head. Here a non-official run in any round disqualifies the
 * aggregate outright, which is how the average actually works in the arena.
 * See docs/SPEC-DELTAS.md D4.
 */
export function calculateAggregate(
  rounds: RoundScore[],
  config: ScoringConfig,
  numRounds: number,
): AggregateResult | null {
  if (rounds.length === 0) return null;

  const contestantId = rounds[0].contestant_id;
  const seen = new Map<number, RoundScore>();
  for (const r of rounds) seen.set(r.go_round, r);

  // Every round must be present and official.
  for (let round = 1; round <= numRounds; round++) {
    const run = seen.get(round);
    if (!run || run.status !== 'official') {
      return {
        contestant_id: contestantId,
        aggregate_value: 0,
        rounds_counted: [...seen.values()].filter((r) => r.status === 'official')
          .length,
        complete: false,
      };
    }
  }

  const values: number[] = [];
  for (let round = 1; round <= numRounds; round++) {
    const run = seen.get(round)!;
    const value = config.mode === 'judged' ? run.final_score : run.final_time;
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return {
        contestant_id: contestantId,
        aggregate_value: 0,
        rounds_counted: 0,
        complete: false,
      };
    }
    values.push(value);
  }

  const total = values.reduce((s, v) => s + v, 0);
  const places = config.mode === 'timed' ? (config.time_precision ?? 2) : 2;

  return {
    contestant_id: contestantId,
    aggregate_value: Math.round(total * 10 ** places) / 10 ** places,
    rounds_counted: numRounds,
    complete: true,
  };
}

/** Turn per-contestant aggregates into records the ranker can place. */
export function aggregatesToRankable(
  aggregates: AggregateResult[],
  mode: 'judged' | 'timed',
): Rankable[] {
  return aggregates
    .filter((a) => a.complete)
    .map((a) => ({
      contestant_id: a.contestant_id,
      status: 'official' as const,
      final_score: mode === 'judged' ? a.aggregate_value : null,
      final_time: mode === 'timed' ? a.aggregate_value : null,
    }));
}

// ---------------------------------------------------------------------------
// D-format (barrel racing / NBHA / pole bending)
// ---------------------------------------------------------------------------

export interface DAssignment {
  contestant_id: string;
  division: number;
  final_time: number;
  /** Seconds behind the fastest qualified time of the whole draw. */
  offset: number;
}

/**
 * Assign every qualified run to a division by how far off the fastest time it
 * is. 1D is the fastest bracket; the last division is open-ended.
 *
 * `time_splits` are the LOWER bounds of each division, ascending, starting at
 * 0. For a 4D with [0, 0.5, 1.0, 2.0]: 1D is 0–0.5s off, 2D is 0.5–1.0, 3D is
 * 1.0–2.0, 4D is 2.0 and beyond.
 *
 * The architecture's loop runs to `time_splits.length - 1` and defaults
 * everything else to `dConfig.divisions`. That is only correct when the split
 * array has exactly one entry per division. If a config supplies fewer splits
 * than divisions — which nothing in the schema prevents — runs land in the
 * last division instead of the one they belong to, silently. This version
 * validates the two lengths against each other. See docs/SPEC-DELTAS.md D5.
 */
export function assignDDivisions(
  scores: Rankable[],
  dConfig: DFormatConfig,
): { assignments: DAssignment[]; error?: string } {
  if (dConfig.time_splits.length !== dConfig.divisions) {
    return {
      assignments: [],
      error:
        `D-format config declares ${dConfig.divisions} divisions but ` +
        `${dConfig.time_splits.length} time splits; they must match.`,
    };
  }

  const qualified = scores.filter(
    (s) =>
      s.status === 'official' &&
      s.final_time !== null &&
      s.final_time !== undefined &&
      Number.isFinite(s.final_time),
  );

  if (qualified.length === 0) return { assignments: [] };

  const fastest = Math.min(...qualified.map((s) => s.final_time as number));
  const assignments: DAssignment[] = [];

  for (const score of qualified) {
    const time = score.final_time as number;
    const offset = Math.round((time - fastest) * 1000) / 1000;

    // Walk down from the last division: the first lower bound the run clears
    // is its division.
    let division = 1;
    for (let d = dConfig.time_splits.length - 1; d >= 0; d--) {
      if (offset >= dConfig.time_splits[d]) {
        division = d + 1;
        break;
      }
    }

    assignments.push({
      contestant_id: score.contestant_id,
      division,
      final_time: time,
      offset,
    });
  }

  return { assignments };
}
