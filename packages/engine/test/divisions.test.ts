import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkDivisionEligibility,
  eligibleDivisions,
  type DivisionConfig,
  type TeamNumbers,
} from '../src/scoring/divisions.ts';
import { calculateJudgedScore } from '../src/scoring/judged.ts';
import { calculateTimedScore } from '../src/scoring/timed.ts';
import type { ScoringConfig } from '../src/types/index.ts';

// ---------------------------------------------------------------------------
// PBR four-judge structure — regression for SPEC-DELTAS D21
// ---------------------------------------------------------------------------

const PBR_2026: ScoringConfig = {
  mode: 'judged',
  max_score: 100,
  components: [
    { name: 'rider', min: 0, max: 25, judges: 4 },
    { name: 'animal', min: 0, max: 25, judges: 4 },
  ],
  score_divisor: 2,
  increment: 0.1,
  variance_cap: 3.0,
  variance_cap_is_advisory: true,
  dq_triggers: ['free_arm_touches_animal_or_self'],
};

const fourJudges = (rider: number, animal: number) => ({
  judges: [1, 2, 3, 4].map((position) => ({
    judge_id: `j${position}`,
    judge_position: position,
    components: [
      { name: 'rider', value: rider },
      { name: 'animal', value: animal },
    ],
  })),
});

describe('PBR 2026 four-judge scoring', () => {
  it('combines eight marks and divides by two', () => {
    // Four judges each mark 22.5 rider / 22.0 bull.
    // Sum = 90 + 88 = 178. Official score = 89.0.
    const r = calculateJudgedScore(fourJudges(22.5, 22.0), PBR_2026);
    assert.equal(r.valid, true);
    assert.equal(r.status, 'official');
    assert.equal(r.final_score, 89);
    assert.equal(r.rider_score, 45);
    assert.equal(r.animal_score, 44);
  });

  it('produces the quarter-point scores PBR actually posts', () => {
    // 0.1 marks over four judges, halved, land on 0.05 steps.
    const r = calculateJudgedScore(fourJudges(22.4, 22.3), PBR_2026);
    assert.equal(r.final_score, 89.4);
  });

  it('cannot exceed 100 with four maximum cards', () => {
    const r = calculateJudgedScore(fourJudges(25, 25), PBR_2026);
    assert.equal(r.final_score, 100);
    assert.ok(!r.issues.some((i) => i.code === 'ABOVE_MAX_SCORE'));
  });

  it('rejects a ride only one judge marked', () => {
    const r = calculateJudgedScore(
      {
        judges: [
          {
            judge_id: 'j1',
            judge_position: 1,
            components: [
              { name: 'rider', value: 22.5 },
              { name: 'animal', value: 22.0 },
            ],
          },
        ],
      },
      PBR_2026,
    );
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.code === 'JUDGE_COUNT_MISMATCH'));
  });

  it('applies the variance cap to the post-divisor scores', () => {
    // Rider 24.0 x4 = 96 -> 48. Bull 22.0 x4 = 88 -> 44. Variance 4.0 > 3.0.
    const r = calculateJudgedScore(fourJudges(24.0, 22.0), PBR_2026);
    assert.equal(r.rider_score, 48);
    assert.equal(r.animal_score, 44);
    const issue = r.issues.find((i) => i.code === 'SCORE_VARIANCE_EXCEEDED');
    assert.ok(issue, 'variance is flagged');
    assert.equal(issue!.severity, 'warning');
    assert.equal(r.valid, true, 'and the ride still scores');
  });

  it('does not flag a rider marked below the bull, however far below', () => {
    const r = calculateJudgedScore(fourJudges(18.0, 24.0), PBR_2026);
    assert.ok(!r.issues.some((i) => i.code === 'SCORE_VARIANCE_EXCEEDED'));
  });

  it('leaves a divisor-free PRCA config summing straight to 100', () => {
    const prca: ScoringConfig = {
      mode: 'judged',
      max_score: 100,
      components: [
        { name: 'rider', min: 0, max: 25, judges: 2 },
        { name: 'animal', min: 0, max: 25, judges: 2 },
      ],
      increment: 0.5,
    };
    const r = calculateJudgedScore(
      {
        judges: [1, 2].map((p) => ({
          judge_id: `j${p}`,
          judge_position: p,
          components: [
            { name: 'rider', value: 21 },
            { name: 'animal', value: 22 },
          ],
        })),
      },
      prca,
    );
    assert.equal(r.final_score, 86);
  });
});

// ---------------------------------------------------------------------------
// USTRC five-second barrier
// ---------------------------------------------------------------------------

describe('USTRC team roping penalties', () => {
  const USTRC: ScoringConfig = {
    mode: 'timed',
    time_precision: 2,
    timed_penalties: [
      { type: 'barrier_break', seconds: 5.0 },
      { type: 'one_leg_catch', seconds: 5.0 },
    ],
    dq_triggers: ['crossfire', 'no_catch', 'illegal_head_catch'],
  };

  it('charges five seconds for the barrier, not the PRCA ten', () => {
    const r = calculateTimedScore(
      { raw_time: 6.42, penalties: [{ type: 'barrier_break' }] },
      USTRC,
    );
    assert.equal(r.final_time, 11.42);
  });

  it('charges barrier and one leg together', () => {
    const r = calculateTimedScore(
      {
        raw_time: 6.42,
        penalties: [{ type: 'barrier_break' }, { type: 'one_leg_catch' }],
      },
      USTRC,
    );
    assert.equal(r.penalty_seconds, 10);
    assert.equal(r.final_time, 16.42);
  });

  it('is a no-time on a crossfire', () => {
    const r = calculateTimedScore(
      { raw_time: 5.1, dq_triggers: ['crossfire'] },
      USTRC,
    );
    assert.equal(r.status, 'no_time');
    assert.equal(r.final_time, null);
  });
});

// ---------------------------------------------------------------------------
// Numbered divisions
// ---------------------------------------------------------------------------

const WSTR: DivisionConfig = {
  system: 'WSTR',
  season: '2026',
  divisions: [
    {
      name: '#7.5',
      max_combined: 7.5,
      header_cap: 4,
      heeler_cap: 4,
      excluded_numbers: [4.5],
      elite_excluded: true,
    },
    { name: '#9.5', max_combined: 9.5, header_cap: 6, heeler_cap: 6 },
    { name: '#11.5', max_combined: 11.5, header_cap: 8, heeler_cap: 8 },
    { name: 'Open', max_combined: null },
  ],
};

const team = (h: number, l: number, extra: Partial<TeamNumbers> = {}): TeamNumbers => ({
  header_id: 'header',
  header_number: h,
  heeler_id: 'heeler',
  heeler_number: l,
  ...extra,
});

describe('checkDivisionEligibility', () => {
  it('lets a legal team in', () => {
    const r = checkDivisionEligibility(team(3.5, 4), WSTR.divisions[0], WSTR);
    assert.equal(r.eligible, true);
    assert.equal(r.combined, 7.5);
  });

  it('adds halves exactly', () => {
    // 4.5 + 5.5 must be 10, not 9.999999999999998.
    const r = checkDivisionEligibility(team(4.5, 5.5), WSTR.divisions[2], WSTR);
    assert.equal(r.combined, 10);
    assert.equal(r.eligible, true);
  });

  it('turns away a team over the combined cap', () => {
    const r = checkDivisionEligibility(team(4, 5), WSTR.divisions[0], WSTR);
    assert.equal(r.eligible, false);
    assert.ok(r.issues.some((i) => i.code === 'OVER_DIVISION_CAP'));
  });

  it('turns away a high header even when the total fits', () => {
    // 5 + 2 = 7, under the 7.5 cap, but the heading end caps at 4.
    const r = checkDivisionEligibility(team(5, 2), WSTR.divisions[0], WSTR);
    assert.equal(r.eligible, false);
    assert.ok(r.issues.some((i) => i.code === 'HEADER_OVER_END_CAP'));
  });

  it('bars a #4.5 from the #7.5 outright', () => {
    const r = checkDivisionEligibility(team(3, 4.5), WSTR.divisions[0], WSTR);
    assert.equal(r.eligible, false);
    assert.ok(r.issues.some((i) => i.code === 'NUMBER_EXCLUDED'));
  });

  it('bars an elite roper from a protected division', () => {
    const r = checkDivisionEligibility(
      team(3.5, 4, { header_elite: true }),
      WSTR.divisions[0],
      WSTR,
    );
    assert.equal(r.eligible, false);
    assert.ok(r.issues.some((i) => i.code === 'ELITE_EXCLUDED'));
  });

  it('lets that same elite roper into the open', () => {
    const r = checkDivisionEligibility(
      team(3.5, 4, { header_elite: true }),
      WSTR.divisions[3],
      WSTR,
    );
    assert.equal(r.eligible, true);
  });

  it('reports every problem at once, not just the first', () => {
    const r = checkDivisionEligibility(team(6, 4.5), WSTR.divisions[0], WSTR);
    const codes = r.issues.map((i) => i.code).sort();
    // #6 header: over the 4 cap. #4.5 heeler: over the 4 cap AND barred
    // outright. Combined #10.5: over the 7.5 cap. Four separate reasons.
    assert.deepEqual(codes, [
      'HEADER_OVER_END_CAP',
      'HEELER_OVER_END_CAP',
      'NUMBER_EXCLUDED',
      'OVER_DIVISION_CAP',
    ]);
  });

  it('enforces heeler-at-least-header where an association requires it', () => {
    const strict = { heeler_at_least_header: true };
    const low = checkDivisionEligibility(team(5, 3), WSTR.divisions[2], strict);
    assert.equal(low.eligible, false);
    assert.ok(low.issues.some((i) => i.code === 'HEELER_BELOW_HEADER'));

    const ok = checkDivisionEligibility(team(3, 5), WSTR.divisions[2], strict);
    assert.equal(ok.eligible, true);
  });

  it('refuses a roper entered on both ends', () => {
    const r = checkDivisionEligibility(
      { header_id: 'same', header_number: 3, heeler_id: 'same', heeler_number: 4 },
      WSTR.divisions[1],
      WSTR,
    );
    assert.equal(r.eligible, false);
    assert.ok(r.issues.some((i) => i.code === 'SAME_ROPER_BOTH_ENDS'));
  });

  it('treats a null cap as open', () => {
    const r = checkDivisionEligibility(team(9, 10), WSTR.divisions[3], WSTR);
    assert.equal(r.eligible, true);
    assert.equal(r.combined, 19);
  });
});

describe('eligibleDivisions', () => {
  it('lists everything a team can enter, lowest first', () => {
    const names = eligibleDivisions(team(3.5, 4), WSTR).map((d) => d.name);
    assert.deepEqual(names, ['#7.5', '#9.5', '#11.5', 'Open']);
  });

  it('drops the divisions an end cap rules out', () => {
    // A #7 header can only enter where the heading end allows a 7.
    const names = eligibleDivisions(team(7, 2), WSTR).map((d) => d.name);
    assert.deepEqual(names, ['#11.5', 'Open']);
  });

  it('leaves a high team only the open', () => {
    const names = eligibleDivisions(team(9, 9), WSTR).map((d) => d.name);
    assert.deepEqual(names, ['Open']);
  });
});
