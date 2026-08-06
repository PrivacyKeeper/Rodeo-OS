/**
 * Judged event scoring — bareback, saddle bronc, bull riding, reined cow horse.
 *
 * Architecture ref: §5.3 "JUDGED SCORING".
 */

import type {
  JudgedRunInput,
  JudgedScoreResult,
  ScoringConfig,
  ValidationIssue,
} from '../types/index.ts';

/**
 * Increment check without floating-point noise.
 *
 * The architecture computes `(value * 10) % (increment * 10)`, which fails for
 * the increment it was written for: 24.3 * 10 is 242.99999999999997 in IEEE
 * 754, so `% 1` yields 0.9999999999999716 and a perfectly legal PBR score is
 * rejected as "not in 0.1 increments". Working in scaled integers avoids it.
 * See docs/SPEC-DELTAS.md D17.
 */
function isMultipleOf(value: number, increment: number): boolean {
  if (!increment) return true;
  const scale = 1000;
  const v = Math.round(value * scale);
  const inc = Math.round(increment * scale);
  if (inc === 0) return true;
  return v % inc === 0;
}

export function calculateJudgedScore(
  input: JudgedRunInput,
  config: ScoringConfig,
): JudgedScoreResult {
  const issues: ValidationIssue[] = [];
  const judges = input.judges ?? [];

  const base: JudgedScoreResult = {
    kind: 'judged',
    valid: false,
    status: 'provisional',
    issues,
    final_score: null,
    rider_score: null,
    animal_score: null,
    judge_scores: judges,
  };

  if (config.mode !== 'judged') {
    issues.push({
      field: 'config',
      code: 'WRONG_MODE',
      severity: 'error',
      message: `Config is '${config.mode}', not 'judged'.`,
    });
    return base;
  }

  const components = config.components ?? [];
  if (components.length === 0) {
    issues.push({
      field: 'config.components',
      code: 'NO_COMPONENTS',
      severity: 'error',
      message: 'Judged config defines no scoring components.',
    });
    return base;
  }

  // ---- Disqualifications come first. A DQ'd ride has no score at all. ------
  const firedTriggers = (input.dq_triggers ?? []).filter((t) =>
    (config.dq_triggers ?? []).includes(t),
  );

  if (config.mark_out_required && input.marked_out === false) {
    if (!firedTriggers.includes('mark_out_violation')) {
      firedTriggers.push('mark_out_violation');
    }
  }

  if (firedTriggers.length > 0) {
    return {
      ...base,
      valid: true,
      status: 'dq',
      dq_reason: firedTriggers.join(', '),
    };
  }

  // ---- Per-judge validation ------------------------------------------------
  for (const judge of judges) {
    for (const component of judge.components) {
      const spec = components.find((c) => c.name === component.name);
      const field = `judge_${judge.judge_position}.${component.name}`;

      if (!spec) {
        issues.push({
          field,
          code: 'UNKNOWN_COMPONENT',
          severity: 'error',
          message: `Unknown scoring component '${component.name}'.`,
        });
        continue;
      }

      if (!Number.isFinite(component.value)) {
        issues.push({
          field,
          code: 'NOT_A_NUMBER',
          severity: 'error',
          message: `Score for '${component.name}' is not a number.`,
        });
        continue;
      }

      if (component.value < spec.min || component.value > spec.max) {
        issues.push({
          field,
          code: 'OUT_OF_RANGE',
          severity: 'error',
          message:
            `Score ${component.value} is outside the allowed range ` +
            `[${spec.min}, ${spec.max}] for '${component.name}'.`,
        });
      }

      if (config.increment && !isMultipleOf(component.value, config.increment)) {
        issues.push({
          field,
          code: 'BAD_INCREMENT',
          severity: 'error',
          message:
            `Score ${component.value} is not a multiple of ${config.increment}.`,
        });
      }
    }
  }

  // ---- Judge-count check ---------------------------------------------------
  // A ride is not scoreable until the required number of judges have marked
  // each component. The architecture never checks this, so a single judge's
  // card produced a "valid" half score. See docs/SPEC-DELTAS.md D18.
  for (const spec of components) {
    const marks = judges.filter((j) =>
      j.components.some((c) => c.name === spec.name),
    ).length;
    if (marks !== spec.judges) {
      issues.push({
        field: `components.${spec.name}`,
        code: 'JUDGE_COUNT_MISMATCH',
        severity: 'error',
        message:
          `'${spec.name}' requires ${spec.judges} judge mark(s), got ${marks}.`,
      });
    }
  }

  const positions = judges.map((j) => j.judge_position);
  if (new Set(positions).size !== positions.length) {
    issues.push({
      field: 'judges',
      code: 'DUPLICATE_JUDGE_POSITION',
      severity: 'error',
      message: 'Two cards were submitted for the same judge position.',
    });
  }

  if (issues.some((i) => i.severity === 'error')) {
    return base;
  }

  // ---- Totals --------------------------------------------------------------
  const sumOf = (predicate: (name: string) => boolean): number =>
    judges.reduce(
      (total, judge) =>
        total +
        judge.components
          .filter((c) => predicate(c.name))
          .reduce((s, c) => s + c.value, 0),
      0,
    );

  // PBR's four judges each mark the rider 0-25 and the bull 0-25; the eight
  // marks are "combined and then divided by two" to reach the 100-point score.
  // PRCA's two judges sum straight to 100 and divide by one.
  const divisor =
    config.score_divisor && config.score_divisor > 0 ? config.score_divisor : 1;

  const riderTotal = sumOf((n) => n === 'rider') / divisor;
  const animalTotal = sumOf((n) => n === 'animal' || n.includes('bull')) / divisor;
  const finalScore =
    judges.reduce(
      (total, judge) => total + judge.components.reduce((s, c) => s + c.value, 0),
      0,
    ) / divisor;

  // ---- Variance cap --------------------------------------------------------
  // §5.7 is explicit that this is a review flag, not a rejection: "Warning
  // flag, not hard rejection. Judges can override." The reference code in §5.3
  // returns valid:false with severity 'warning', which is a contradiction and
  // in practice blocks the score. Advisory is the default here; a config can
  // opt into hard enforcement. See docs/SPEC-DELTAS.md D11.
  if (config.variance_cap !== undefined) {
    const variance = riderTotal - animalTotal;
    if (variance > config.variance_cap) {
      const advisory = config.variance_cap_is_advisory !== false;
      issues.push({
        field: 'variance',
        code: 'SCORE_VARIANCE_EXCEEDED',
        severity: advisory ? 'warning' : 'error',
        message:
          `Rider score exceeds animal score by ${variance.toFixed(1)} points ` +
          `(cap ${config.variance_cap.toFixed(1)}).`,
      });
      if (!advisory) return base;
    }
  }

  if (config.max_score !== undefined && finalScore > config.max_score) {
    issues.push({
      field: 'final_score',
      code: 'ABOVE_MAX_SCORE',
      severity: 'error',
      message: `Total ${finalScore} exceeds the maximum of ${config.max_score}.`,
    });
    return base;
  }

  // ---- Qualification floor -------------------------------------------------
  if (
    config.min_score_to_place !== undefined &&
    finalScore <= config.min_score_to_place
  ) {
    issues.push({
      field: 'final_score',
      code: 'BELOW_PLACING_FLOOR',
      severity: 'warning',
      message:
        `Score ${finalScore} does not exceed the placing floor of ` +
        `${config.min_score_to_place}; the ride is scored but cannot place.`,
    });
  }

  return {
    kind: 'judged',
    valid: true,
    status: 'official',
    issues,
    final_score: round2(finalScore),
    rider_score: round2(riderTotal),
    animal_score: round2(animalTotal),
    judge_scores: judges,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
