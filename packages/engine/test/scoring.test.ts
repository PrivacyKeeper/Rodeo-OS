import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { calculateJudgedScore } from '../src/scoring/judged.ts';
import { calculateTimedScore } from '../src/scoring/timed.ts';
import { rankResults, tieGroups } from '../src/scoring/rank.ts';
import {
  assignDDivisions,
  calculateAggregate,
} from '../src/scoring/aggregate.ts';
import type {
  Rankable,
  ScoringConfig,
} from '../src/types/index.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRCA_BRONC: ScoringConfig = {
  mode: 'judged',
  max_score: 100,
  components: [
    { name: 'rider', min: 0, max: 25, judges: 2 },
    { name: 'animal', min: 0, max: 25, judges: 2 },
  ],
  increment: 0.5,
  ride_duration_seconds: 8,
  mark_out_required: true,
  dq_triggers: ['mark_out_violation', 'free_arm_touches_animal_or_self'],
  tie_resolution: 'combine_and_split',
};

const PBR_BULLS: ScoringConfig = {
  mode: 'judged',
  max_score: 100,
  components: [
    { name: 'rider', min: 0, max: 50, judges: 1 },
    { name: 'animal', min: 0, max: 50, judges: 1 },
  ],
  increment: 0.1,
  variance_cap: 3.0,
  variance_cap_is_advisory: true,
  dq_triggers: ['free_arm_touches_animal_or_self'],
  tie_resolution: 'combine_and_split',
};

const TIE_DOWN: ScoringConfig = {
  mode: 'timed',
  time_precision: 1,
  timed_penalties: [{ type: 'barrier_break', seconds: 10 }],
  tie_must_hold_seconds: 6,
  dq_triggers: ['no_catch', 'tie_did_not_hold'],
  tie_resolution: 'combine_and_split',
};

const BARRELS: ScoringConfig = {
  mode: 'timed',
  time_precision: 3,
  timed_penalties: [
    { type: 'barrel_knockdown', seconds: 5, repeatable: true },
  ],
  dq_triggers: ['off_pattern'],
  tie_resolution: 'combine_and_split',
};

const twoJudges = (rider: number, animal: number) => ({
  judges: [
    {
      judge_id: 'j1',
      judge_position: 1,
      components: [
        { name: 'rider', value: rider / 2 },
        { name: 'animal', value: animal / 2 },
      ],
    },
    {
      judge_id: 'j2',
      judge_position: 2,
      components: [
        { name: 'rider', value: rider / 2 },
        { name: 'animal', value: animal / 2 },
      ],
    },
  ],
  marked_out: true,
});

// ---------------------------------------------------------------------------
// Judged
// ---------------------------------------------------------------------------

describe('calculateJudgedScore', () => {
  it('adds up two judges into a 100-point ride', () => {
    const r = calculateJudgedScore(twoJudges(42, 44), PRCA_BRONC);
    assert.equal(r.valid, true);
    assert.equal(r.status, 'official');
    assert.equal(r.final_score, 86);
    assert.equal(r.rider_score, 42);
    assert.equal(r.animal_score, 44);
  });

  it('rejects a score outside a component range', () => {
    const r = calculateJudgedScore(twoJudges(60, 40), PRCA_BRONC);
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.code === 'OUT_OF_RANGE'));
  });

  it('rejects a score off the increment', () => {
    const input = twoJudges(42, 44);
    input.judges[0].components[0].value = 21.25; // not a 0.5 step
    const r = calculateJudgedScore(input, PRCA_BRONC);
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.code === 'BAD_INCREMENT'));
  });

  // Regression for SPEC-DELTAS D17. The architecture's modulo check reports a
  // legal PBR score as being off-increment because 24.3 * 10 is not 243 in
  // binary floating point.
  it('accepts 0.1 increments that trip naive float modulo', () => {
    for (const value of [24.3, 46.7, 0.7, 8.1, 29.9, 45.3]) {
      const r = calculateJudgedScore(
        {
          judges: [
            {
              judge_id: 'j1',
              judge_position: 1,
              components: [
                { name: 'rider', value },
                { name: 'animal', value: 40 },
              ],
            },
          ],
        },
        PBR_BULLS,
      );
      assert.ok(
        !r.issues.some((i) => i.code === 'BAD_INCREMENT'),
        `${value} was wrongly rejected as off-increment`,
      );
    }
  });

  // Regression for SPEC-DELTAS D11. §5.7 says the variance cap is a review
  // flag; the reference code returns valid:false, which blocks the score.
  it('flags a variance-cap breach as a warning, not a rejection', () => {
    const r = calculateJudgedScore(
      {
        judges: [
          {
            judge_id: 'j1',
            judge_position: 1,
            components: [
              { name: 'rider', value: 46.5 },
              { name: 'animal', value: 42.0 },
            ],
          },
        ],
      },
      PBR_BULLS,
    );
    assert.equal(r.valid, true, 'the ride still scores');
    assert.equal(r.final_score, 88.5);
    const issue = r.issues.find((i) => i.code === 'SCORE_VARIANCE_EXCEEDED');
    assert.ok(issue, 'variance is flagged');
    assert.equal(issue!.severity, 'warning');
  });

  it('hard-rejects a variance breach when the config says to', () => {
    const strict = { ...PBR_BULLS, variance_cap_is_advisory: false };
    const r = calculateJudgedScore(
      {
        judges: [
          {
            judge_id: 'j1',
            judge_position: 1,
            components: [
              { name: 'rider', value: 46.5 },
              { name: 'animal', value: 42.0 },
            ],
          },
        ],
      },
      strict,
    );
    assert.equal(r.valid, false);
  });

  it('disqualifies a bronc ride that missed the mark-out', () => {
    const input = twoJudges(42, 44);
    input.marked_out = false;
    const r = calculateJudgedScore(input, PRCA_BRONC);
    assert.equal(r.status, 'dq');
    assert.equal(r.final_score, null);
    assert.match(r.dq_reason!, /mark_out_violation/);
  });

  it('does not require a mark-out in bull riding', () => {
    const r = calculateJudgedScore(
      {
        judges: [
          {
            judge_id: 'j1',
            judge_position: 1,
            components: [
              { name: 'rider', value: 44 },
              { name: 'animal', value: 44 },
            ],
          },
        ],
        marked_out: false,
      },
      PBR_BULLS,
    );
    assert.equal(r.status, 'official');
  });

  // Regression for SPEC-DELTAS D18.
  it('will not score a ride that only one of two judges marked', () => {
    const r = calculateJudgedScore(
      {
        judges: [
          {
            judge_id: 'j1',
            judge_position: 1,
            components: [
              { name: 'rider', value: 21 },
              { name: 'animal', value: 22 },
            ],
          },
        ],
        marked_out: true,
      },
      PRCA_BRONC,
    );
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.code === 'JUDGE_COUNT_MISMATCH'));
  });

  it('rejects two cards from the same judge position', () => {
    const input = twoJudges(42, 44);
    input.judges[1].judge_position = 1;
    const r = calculateJudgedScore(input, PRCA_BRONC);
    assert.ok(r.issues.some((i) => i.code === 'DUPLICATE_JUDGE_POSITION'));
  });
});

// ---------------------------------------------------------------------------
// Timed
// ---------------------------------------------------------------------------

describe('calculateTimedScore', () => {
  it('adds a barrier penalty to the raw time', () => {
    const r = calculateTimedScore(
      { raw_time: 8.4, penalties: [{ type: 'barrier_break' }], tie_held_seconds: 6 },
      TIE_DOWN,
    );
    assert.equal(r.status, 'official');
    assert.equal(r.final_time, 18.4);
    assert.equal(r.penalty_seconds, 10);
  });

  it('records a clean run untouched', () => {
    const r = calculateTimedScore({ raw_time: 8.4, tie_held_seconds: 6 }, TIE_DOWN);
    assert.equal(r.final_time, 8.4);
    assert.equal(r.penalty_seconds, 0);
  });

  it('is a no-time when the tie does not hold six seconds', () => {
    const r = calculateTimedScore(
      { raw_time: 7.9, tie_held_seconds: 4 },
      TIE_DOWN,
    );
    assert.equal(r.status, 'no_time');
    assert.equal(r.final_time, null);
    assert.match(r.dq_reason!, /tie_did_not_hold/);
  });

  it('is a no-time when the clock never started', () => {
    const r = calculateTimedScore({ raw_time: null }, TIE_DOWN);
    assert.equal(r.status, 'no_time');
    assert.equal(r.final_time, null);
  });

  it('charges five seconds per barrel', () => {
    const r = calculateTimedScore(
      { raw_time: 15.234, barrels_knocked: 2 },
      BARRELS,
    );
    assert.equal(r.final_time, 25.234);
    assert.equal(r.penalty_seconds, 10);
  });

  // Regression for SPEC-DELTAS D19: the architecture applied barrels_knocked
  // and an explicit barrel_knockdown penalty separately, charging twice.
  it('does not double-charge when barrels arrive by both routes', () => {
    const r = calculateTimedScore(
      {
        raw_time: 15.234,
        barrels_knocked: 1,
        penalties: [{ type: 'barrel_knockdown' }],
      },
      BARRELS,
    );
    assert.equal(r.penalty_seconds, 5, 'one barrel is one five-second penalty');
    assert.equal(r.final_time, 20.234);
  });

  it('applies a non-repeatable penalty once however many are sent', () => {
    const r = calculateTimedScore(
      {
        raw_time: 8.4,
        penalties: [{ type: 'barrier_break', count: 3 }],
        tie_held_seconds: 6,
      },
      TIE_DOWN,
    );
    assert.equal(r.penalty_seconds, 10);
  });

  it('rejects a penalty the event does not define', () => {
    const r = calculateTimedScore(
      { raw_time: 8.4, penalties: [{ type: 'crossfire' }], tie_held_seconds: 6 },
      TIE_DOWN,
    );
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.code === 'UNKNOWN_PENALTY'));
  });

  it('keeps the precision the event is timed at', () => {
    const tenths = calculateTimedScore({ raw_time: 8.44, tie_held_seconds: 6 }, TIE_DOWN);
    assert.equal(tenths.final_time, 8.4);

    const thousandths = calculateTimedScore({ raw_time: 15.2345 }, BARRELS);
    assert.equal(thousandths.final_time, 15.235); // rounds half up
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const timed = (id: string, t: number | null, status = 'official'): Rankable => ({
  contestant_id: id,
  status: status as Rankable['status'],
  final_time: t,
  final_score: null,
});

const judged = (id: string, s: number, status = 'official'): Rankable => ({
  contestant_id: id,
  status: status as Rankable['status'],
  final_score: s,
  final_time: null,
});

describe('rankResults', () => {
  // Regression for SPEC-DELTAS D6. The architecture's filter requires both
  // final_score AND final_time to be non-null, which no real record satisfies,
  // so it returns [] for every input.
  it('ranks a timed field at all', () => {
    const ranked = rankResults(
      [timed('a', 9.1), timed('b', 8.7), timed('c', 10.4)],
      { mode: 'timed', time_precision: 1 },
    );
    assert.equal(ranked.length, 3, 'the field is not silently empty');
    assert.deepEqual(
      ranked.map((r) => r.contestant_id),
      ['b', 'a', 'c'],
    );
    assert.deepEqual(ranked.map((r) => r.place), [1, 2, 3]);
  });

  it('ranks a judged field highest-first', () => {
    const ranked = rankResults([judged('a', 82), judged('b', 88), judged('c', 79)], {
      mode: 'judged',
    });
    assert.deepEqual(
      ranked.map((r) => r.contestant_id),
      ['b', 'a', 'c'],
    );
  });

  // Regression for SPEC-DELTAS D2. After a two-way tie for first, the next
  // contestant is third — the architecture placed them second and the payout
  // engine then paid them the second-place split.
  it('places the runner-up after a tie for first in THIRD', () => {
    const ranked = rankResults(
      [timed('a', 9.1), timed('b', 9.1), timed('c', 9.5)],
      { mode: 'timed', time_precision: 1 },
    );
    assert.deepEqual(ranked.map((r) => r.place), [1, 1, 3]);
    assert.equal(ranked[0].is_tied, true);
    assert.equal(ranked[1].is_tied, true);
    assert.equal(ranked[2].is_tied, false);
    assert.deepEqual(ranked[0].tied_with, ['b']);
  });

  it('handles a three-way tie in the middle of the field', () => {
    const ranked = rankResults(
      [
        timed('a', 8.0),
        timed('b', 9.0),
        timed('c', 9.0),
        timed('d', 9.0),
        timed('e', 10.0),
      ],
      { mode: 'timed', time_precision: 1 },
    );
    assert.deepEqual(ranked.map((r) => r.place), [1, 2, 2, 2, 5]);
  });

  // Regression for SPEC-DELTAS D20.
  it('treats float-noise-identical times as tied', () => {
    const ranked = rankResults(
      [timed('a', 13.7), timed('b', 13.700000000000001)],
      { mode: 'timed', time_precision: 3 },
    );
    assert.deepEqual(ranked.map((r) => r.place), [1, 1]);
    assert.equal(ranked[0].is_tied, true);
  });

  it('excludes no-times, DQs and turnouts from the placings', () => {
    const ranked = rankResults(
      [
        timed('a', 9.1),
        timed('b', null, 'no_time'),
        timed('c', 8.0, 'dq'),
        timed('d', 9.9, 'turned_out'),
        timed('e', 10.1),
      ],
      { mode: 'timed', time_precision: 1 },
    );
    assert.deepEqual(
      ranked.map((r) => r.contestant_id),
      ['a', 'e'],
    );
  });

  it('applies a placing floor when the config sets one', () => {
    const ranked = rankResults(
      [judged('a', 115), judged('b', 108), judged('c', 130)],
      { mode: 'judged', min_score_to_place: 110 },
    );
    assert.deepEqual(
      ranked.map((r) => r.contestant_id),
      ['c', 'a'],
    );
  });

  it('returns an empty field when nobody qualified', () => {
    const ranked = rankResults(
      [timed('a', null, 'no_time'), timed('b', null, 'no_time')],
      { mode: 'timed' },
    );
    assert.deepEqual(ranked, []);
  });
});

describe('tieGroups', () => {
  it('groups by place in order', () => {
    const ranked = rankResults(
      [timed('a', 9.1), timed('b', 9.1), timed('c', 9.5), timed('d', 9.9)],
      { mode: 'timed', time_precision: 1 },
    );
    const groups = tieGroups(ranked);
    assert.deepEqual(groups.map((g) => g.length), [2, 1, 1]);
    assert.deepEqual(groups.map((g) => g[0].place), [1, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

describe('calculateAggregate', () => {
  it('sums two clean rounds', () => {
    const agg = calculateAggregate(
      [
        { contestant_id: 'a', go_round: 1, status: 'official', final_time: 9.1 },
        { contestant_id: 'a', go_round: 2, status: 'official', final_time: 8.7 },
      ],
      { mode: 'timed', time_precision: 1 },
      2,
    );
    assert.equal(agg!.complete, true);
    assert.equal(agg!.aggregate_value, 17.8);
  });

  // Regression for SPEC-DELTAS D4.
  it('gives no average to a contestant who missed a round', () => {
    const agg = calculateAggregate(
      [
        { contestant_id: 'a', go_round: 1, status: 'official', final_time: 9.1 },
        { contestant_id: 'a', go_round: 2, status: 'no_time', final_time: null },
      ],
      { mode: 'timed', time_precision: 1 },
      2,
    );
    assert.equal(agg!.complete, false);
  });

  it('gives no average when a round is missing entirely', () => {
    const agg = calculateAggregate(
      [{ contestant_id: 'a', go_round: 1, status: 'official', final_time: 9.1 }],
      { mode: 'timed', time_precision: 1 },
      3,
    );
    assert.equal(agg!.complete, false);
  });
});

// ---------------------------------------------------------------------------
// D-format
// ---------------------------------------------------------------------------

describe('assignDDivisions', () => {
  const D4 = {
    divisions: 4,
    time_splits: [0, 0.5, 1.0, 2.0],
    division_pcts: [0.35, 0.3, 0.2, 0.15],
  };

  it('splits the field off the fastest time', () => {
    const { assignments } = assignDDivisions(
      [
        timed('a', 15.0), // fastest -> 1D
        timed('b', 15.4), // +0.4    -> 1D
        timed('c', 15.7), // +0.7    -> 2D
        timed('d', 16.5), // +1.5    -> 3D
        timed('e', 18.0), // +3.0    -> 4D
      ],
      D4,
    );
    const byId = new Map(assignments.map((a) => [a.contestant_id, a.division]));
    assert.equal(byId.get('a'), 1);
    assert.equal(byId.get('b'), 1);
    assert.equal(byId.get('c'), 2);
    assert.equal(byId.get('d'), 3);
    assert.equal(byId.get('e'), 4);
  });

  it('puts a run exactly on a boundary in the slower division', () => {
    const { assignments } = assignDDivisions([timed('a', 15.0), timed('b', 15.5)], D4);
    assert.equal(assignments.find((a) => a.contestant_id === 'b')!.division, 2);
  });

  it('ignores no-times', () => {
    const { assignments } = assignDDivisions(
      [timed('a', 15.0), timed('b', null, 'no_time')],
      D4,
    );
    assert.equal(assignments.length, 1);
  });

  // Regression for SPEC-DELTAS D5.
  it('refuses a config whose splits do not match its division count', () => {
    const { assignments, error } = assignDDivisions([timed('a', 15.0)], {
      divisions: 4,
      time_splits: [0, 0.5, 1.0],
      division_pcts: [0.35, 0.3, 0.2, 0.15],
    });
    assert.equal(assignments.length, 0);
    assert.match(error!, /divisions/);
  });
});
