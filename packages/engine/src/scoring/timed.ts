/**
 * Timed event scoring — roping, steer wrestling, barrels, breakaway, goats.
 *
 * Architecture ref: §5.3 "TIMED SCORING".
 */

import type {
  ScoringConfig,
  TimedRunInput,
  TimedScoreResult,
  ValidationIssue,
} from '../types/index.ts';

export function calculateTimedScore(
  input: TimedRunInput,
  config: ScoringConfig,
): TimedScoreResult {
  const issues: ValidationIssue[] = [];

  const base: TimedScoreResult = {
    kind: 'timed',
    valid: false,
    status: 'provisional',
    issues,
    raw_time: input.raw_time,
    penalty_seconds: 0,
    penalties_applied: [],
    final_time: null,
  };

  if (config.mode !== 'timed') {
    issues.push({
      field: 'config',
      code: 'WRONG_MODE',
      severity: 'error',
      message: `Config is '${config.mode}', not 'timed'.`,
    });
    return base;
  }

  // ---- Disqualification ----------------------------------------------------
  const firedTriggers = (input.dq_triggers ?? []).filter((t) =>
    (config.dq_triggers ?? []).includes(t),
  );

  // Tie-down and goat tying: the tie has to hold for the required count or the
  // run is a no-time regardless of the clock.
  if (
    config.tie_must_hold_seconds !== undefined &&
    input.tie_held_seconds !== undefined &&
    input.tie_held_seconds < config.tie_must_hold_seconds
  ) {
    firedTriggers.push('tie_did_not_hold');
  }

  if (firedTriggers.length > 0) {
    return {
      ...base,
      valid: true,
      status: 'no_time',
      dq_reason: firedTriggers.join(', '),
    };
  }

  // ---- No time -------------------------------------------------------------
  if (input.raw_time === null || input.raw_time === undefined) {
    return { ...base, valid: true, status: 'no_time' };
  }

  if (!Number.isFinite(input.raw_time) || input.raw_time < 0) {
    issues.push({
      field: 'raw_time',
      code: 'INVALID_TIME',
      severity: 'error',
      message: `Raw time ${input.raw_time} is not a valid duration.`,
    });
    return base;
  }

  // ---- Penalties -----------------------------------------------------------
  const rules = config.timed_penalties ?? [];
  const applied: { type: string; seconds: number }[] = [];
  let penaltySeconds = 0;

  // Barrel racing passes a knockdown count; fold it into the ordinary list so
  // there is one code path. The architecture handled it separately and, if a
  // caller supplied BOTH `barrels_knocked` and a 'barrel_knockdown' entry in
  // `penalties`, charged the penalty twice. See docs/SPEC-DELTAS.md D19.
  const requested = new Map<string, number>();
  for (const p of input.penalties ?? []) {
    requested.set(p.type, (requested.get(p.type) ?? 0) + (p.count ?? 1));
  }
  if (input.barrels_knocked && input.barrels_knocked > 0) {
    requested.set(
      'barrel_knockdown',
      Math.max(requested.get('barrel_knockdown') ?? 0, input.barrels_knocked),
    );
  }

  for (const [type, rawCount] of requested) {
    const rule = rules.find((r) => r.type === type);
    if (!rule) {
      issues.push({
        field: `penalties.${type}`,
        code: 'UNKNOWN_PENALTY',
        severity: 'error',
        message: `Penalty '${type}' is not defined for this event.`,
      });
      continue;
    }

    // Non-repeatable penalties apply at most once however many are sent.
    const count = rule.repeatable === true ? rawCount : Math.min(1, rawCount);
    const seconds = rule.seconds * count;
    penaltySeconds += seconds;
    applied.push({ type, seconds });
  }

  if (issues.some((i) => i.severity === 'error')) {
    return { ...base, penalties_applied: applied };
  }

  const precision = config.time_precision ?? 2;
  const finalTime = roundTo(input.raw_time + penaltySeconds, precision);

  return {
    kind: 'timed',
    valid: true,
    status: 'official',
    issues,
    raw_time: input.raw_time,
    penalty_seconds: roundTo(penaltySeconds, precision),
    penalties_applied: applied,
    final_time: finalTime,
  };
}

function roundTo(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
