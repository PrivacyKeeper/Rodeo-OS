/**
 * Ranking and tie detection.
 *
 * Architecture ref: §5.4 "Ranking and Tie Detection".
 *
 * ---------------------------------------------------------------------------
 * THE REFERENCE IMPLEMENTATION DOES NOT WORK. Three separate defects:
 *
 * 1. The qualification filter is unsatisfiable:
 *
 *        scores.filter(s => s.status === 'official'
 *                        && s.final_score !== null
 *                        && s.final_time  !== null)
 *
 *    A judged run has final_time === null and a timed run has
 *    final_score === null, so no record can pass both clauses. rankResults()
 *    as written returns an empty array for every input, in every event, and
 *    the payout engine downstream of it therefore pays nobody. It has to be
 *    mode-dependent. (SPEC-DELTAS D6)
 *
 * 2. Place numbering is wrong. `currentPlace = i + 1 + 1` is only correct
 *    while no tie has occurred, and it is never updated on the tie branch, so
 *    after a two-way tie for first the next contestant is placed 2nd rather
 *    than 3rd — and the payout engine pays them the 2nd-place split, which is
 *    money out the door. (SPEC-DELTAS D2)
 *
 * 3. Ties are detected with `===` on decimals. Two 13.7-second runs that
 *    arrive as 13.700000000000001 and 13.7 are not tied under that test.
 *    Comparison is done here on the value quantised to the event's own
 *    precision. (SPEC-DELTAS D20)
 * ---------------------------------------------------------------------------
 */

import type {
  Rankable,
  RankedResult,
  ScoringConfig,
} from '../types/index.ts';

/** Statuses that represent a completed, placeable run. */
const PLACEABLE = new Set(['official']);

function valueOf(record: Rankable, mode: 'judged' | 'timed'): number | null {
  const raw = mode === 'judged' ? record.final_score : record.final_time;
  return raw === null || raw === undefined || !Number.isFinite(raw)
    ? null
    : raw;
}

/**
 * Quantise to the precision the event is actually scored at, so that two runs
 * the arena calls identical compare identical. Judged events use hundredths;
 * timed events use the config's time_precision.
 */
function quantise(value: number, config: ScoringConfig): number {
  const places = config.mode === 'timed' ? (config.time_precision ?? 2) : 2;
  return Math.round(value * 10 ** places);
}

export function rankResults<T extends Rankable>(
  records: T[],
  config: ScoringConfig,
): RankedResult<T>[] {
  const mode = config.mode;

  const qualified = records
    .map((record) => ({ record, value: valueOf(record, mode) }))
    .filter(
      (r): r is { record: T; value: number } =>
        PLACEABLE.has(r.record.status) && r.value !== null,
    )
    .filter(
      (r) =>
        config.min_score_to_place === undefined ||
        mode !== 'judged' ||
        r.value > config.min_score_to_place,
    );

  // Judged: highest wins. Timed: fastest wins.
  const sorted = [...qualified].sort((a, b) =>
    mode === 'judged' ? b.value - a.value : a.value - b.value,
  );

  // Standard competition ranking ("1224"): a group of N tied contestants all
  // take the group's first place, and the next distinct value is placed at
  // (index of that value) + 1.
  const ranked: RankedResult<T>[] = [];
  let groupStart = 0;

  for (let i = 0; i < sorted.length; i++) {
    const isNewGroup =
      i === 0 ||
      quantise(sorted[i].value, config) !== quantise(sorted[i - 1].value, config);

    if (isNewGroup) groupStart = i;

    ranked.push({
      entry: sorted[i].record,
      contestant_id: sorted[i].record.contestant_id,
      place: groupStart + 1,
      is_tied: false,
      tied_with: [],
      ranked_value: sorted[i].value,
    });
  }

  // Second pass fills in tie membership now that every place is assigned.
  const byPlace = new Map<number, RankedResult<T>[]>();
  for (const r of ranked) {
    const bucket = byPlace.get(r.place) ?? [];
    bucket.push(r);
    byPlace.set(r.place, bucket);
  }

  for (const group of byPlace.values()) {
    if (group.length < 2) continue;
    for (const member of group) {
      member.is_tied = true;
      member.tied_with = group
        .filter((m) => m.contestant_id !== member.contestant_id)
        .map((m) => m.contestant_id);
    }
  }

  return ranked;
}

/**
 * Group a ranked list into tie groups, in place order. A contestant who is not
 * tied is a group of one. This is what the payout engine iterates over.
 */
export function tieGroups<T extends Rankable>(
  ranked: RankedResult<T>[],
): RankedResult<T>[][] {
  const groups: RankedResult<T>[][] = [];
  let current: RankedResult<T>[] = [];

  for (const result of ranked) {
    if (current.length === 0 || current[0].place === result.place) {
      current.push(result);
    } else {
      groups.push(current);
      current = [result];
    }
  }
  if (current.length > 0) groups.push(current);

  return groups;
}
