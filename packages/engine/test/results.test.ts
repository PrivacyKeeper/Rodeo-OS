import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeResults,
  expandTeamResults,
  type ScoreRow,
  type ScoringConfig,
} from '../src/index.ts';

const TIMED: ScoringConfig = { mode: 'timed', time_precision: 2 };
const JUDGED: ScoringConfig = { mode: 'judged' };

const run = (
  id: string,
  round: number,
  time: number | null,
  status = 'official',
): ScoreRow => ({
  contestant_id: id,
  go_round: round,
  status,
  final_time: time,
  final_score: null,
});

describe('computeResults — go-rounds', () => {
  it('places every round independently', () => {
    const { results } = computeResults({
      scores: [
        run('a', 1, 9.1), run('b', 1, 8.7), run('c', 1, 10.4),
        run('a', 2, 8.2), run('b', 2, 9.9), run('c', 2, 9.0),
      ],
      scoring_config: TIMED,
      num_go_rounds: 2,
    });

    const r1 = results.filter((r) => r.result_type === 'go_round' && r.go_round === 1);
    const r2 = results.filter((r) => r.result_type === 'go_round' && r.go_round === 2);
    assert.equal(r1.find((r) => r.contestant_id === 'b')!.place, 1);
    assert.equal(r2.find((r) => r.contestant_id === 'a')!.place, 1, 'the lead changed');
  });

  it('excludes no-times from the placings', () => {
    const { results } = computeResults({
      scores: [run('a', 1, 9.1), run('b', 1, null, 'no_time')],
      scoring_config: TIMED,
      num_go_rounds: 1,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].contestant_id, 'a');
  });

  it('records who a placing is tied with', () => {
    const { results } = computeResults({
      scores: [run('a', 1, 9.1), run('b', 1, 9.1), run('c', 1, 9.5)],
      scoring_config: TIMED,
      num_go_rounds: 1,
    });
    const a = results.find((r) => r.contestant_id === 'a')!;
    assert.equal(a.place, 1);
    assert.deepEqual(a.tied_with, ['b']);
    assert.equal(results.find((r) => r.contestant_id === 'c')!.place, 3);
  });

  it('a single-round event gets no average row', () => {
    const { results } = computeResults({
      scores: [run('a', 1, 9.1), run('b', 1, 9.5)],
      scoring_config: TIMED,
      num_go_rounds: 1,
    });
    assert.equal(results.filter((r) => r.result_type === 'average').length, 0);
  });
});

describe('computeResults — the average', () => {
  it('only contestants who caught in EVERY round place in the average', () => {
    const { results } = computeResults({
      scores: [
        run('a', 1, 9.1), run('a', 2, 8.2),
        run('b', 1, 8.7), run('b', 2, null, 'no_time'),
        run('c', 1, 10.4), run('c', 2, 9.0),
      ],
      scoring_config: TIMED,
      num_go_rounds: 2,
    });

    const avg = results.filter((r) => r.result_type === 'average');
    assert.deepEqual(avg.map((r) => r.contestant_id).sort(), ['a', 'c']);
    assert.equal(avg.find((r) => r.contestant_id === 'a')!.aggregate_score, 17.3);
    assert.equal(avg.find((r) => r.contestant_id === 'a')!.place, 1);
  });

  it('a judged average sums scores, highest wins', () => {
    const judged = (id: string, round: number, score: number): ScoreRow => ({
      contestant_id: id, go_round: round, status: 'official',
      final_score: score, final_time: null,
    });
    const { results } = computeResults({
      scores: [
        judged('a', 1, 84), judged('a', 2, 86),
        judged('b', 1, 88), judged('b', 2, 80),
      ],
      scoring_config: JUDGED,
      num_go_rounds: 2,
    });
    const avg = results.filter((r) => r.result_type === 'average');
    assert.equal(avg.find((r) => r.contestant_id === 'a')!.aggregate_score, 170);
    assert.equal(avg.find((r) => r.contestant_id === 'a')!.place, 1, '170 beats 168');
  });
});

describe('computeResults — D-format', () => {
  it('places within each division instead of an average', () => {
    const { results } = computeResults({
      scores: [
        run('a', 1, 17.2), run('b', 1, 17.4), // 1D
        run('c', 1, 17.8), run('d', 1, 18.0), // 2D
        run('e', 1, 18.5),                     // 3D
        run('f', 1, 19.9),                     // 4D
      ],
      scoring_config: { mode: 'timed', time_precision: 3 },
      num_go_rounds: 1,
      d_format: {
        divisions: 4,
        time_splits: [0, 0.5, 1.0, 2.0],
        division_pcts: [0.35, 0.3, 0.2, 0.15],
      },
    });

    const divisions = results.filter((r) => r.result_type === 'd_division');
    assert.equal(divisions.length, 6);
    assert.equal(divisions.find((r) => r.contestant_id === 'a')!.d_division, 1);
    assert.equal(divisions.find((r) => r.contestant_id === 'c')!.d_division, 2);
    assert.equal(divisions.find((r) => r.contestant_id === 'f')!.d_division, 4);
    // Each division is placed from its own 1st.
    assert.equal(divisions.find((r) => r.contestant_id === 'c')!.place, 1);
    assert.equal(results.filter((r) => r.result_type === 'average').length, 0);
  });
});

describe('computeResults — points', () => {
  it('money-based points credit a dollar as a point', () => {
    const { results } = computeResults({
      scores: [run('a', 1, 9.1), run('b', 1, 9.5)],
      scoring_config: TIMED,
      num_go_rounds: 1,
      points: { basis: 'money' },
      earnings_cents: new Map([['a', 125_000], ['b', 75_000]]),
    });
    assert.equal(results.find((r) => r.contestant_id === 'a')!.points_earned, 1250);
    assert.equal(results.find((r) => r.contestant_id === 'b')!.points_earned, 750);
  });

  it('placing-based points use the association table', () => {
    const { results } = computeResults({
      scores: [run('a', 1, 9.1), run('b', 1, 9.5), run('c', 1, 9.9)],
      scoring_config: TIMED,
      num_go_rounds: 1,
      points: { basis: 'placing', placing_points: [10, 8, 6, 4, 2] },
    });
    assert.equal(results.find((r) => r.contestant_id === 'a')!.points_earned, 10);
    assert.equal(results.find((r) => r.contestant_id === 'c')!.points_earned, 6);
  });

  it('a placing past the points table earns nothing, not undefined', () => {
    const { results } = computeResults({
      scores: [run('a', 1, 9.1), run('b', 1, 9.5), run('c', 1, 9.9)],
      scoring_config: TIMED,
      num_go_rounds: 1,
      points: { basis: 'placing', placing_points: [10] },
    });
    assert.equal(results.find((r) => r.contestant_id === 'c')!.points_earned, 0);
  });

  it('no points config means no points', () => {
    const { results } = computeResults({
      scores: [run('a', 1, 9.1)],
      scoring_config: TIMED,
      num_go_rounds: 1,
    });
    assert.equal(results[0].points_earned, 0);
  });
});

describe('team results', () => {
  const team = (
    entry: string, members: string[], round: number, time: number,
  ): ScoreRow => ({
    contestant_id: entry,
    entry_id: entry,
    team_members: members,
    go_round: round,
    status: 'official',
    final_time: time,
    final_score: null,
  });

  it('a team places once but both ropers land in the standings', () => {
    const { results } = computeResults({
      scores: [
        team('t1', ['header1', 'heeler1'], 1, 6.4),
        team('t2', ['header2', 'heeler2'], 1, 7.1),
      ],
      scoring_config: TIMED,
      num_go_rounds: 1,
    });
    assert.equal(results.length, 2, 'two TEAMS placed');

    const expanded = expandTeamResults(results);
    assert.equal(expanded.length, 4, 'four ropers in the standings');
    assert.ok(expanded.every((r) => !r.contestant_id.startsWith('t')));

    const winners = expanded.filter((r) => r.place === 1).map((r) => r.contestant_id);
    assert.deepEqual(winners.sort(), ['header1', 'heeler1']);
  });

  it('an individual event is untouched by the expansion', () => {
    const { results } = computeResults({
      scores: [run('a', 1, 9.1)],
      scoring_config: TIMED,
      num_go_rounds: 1,
    });
    assert.deepEqual(expandTeamResults(results), results);
  });
});

describe('determinism', () => {
  it('the same scores compute the same results twice', () => {
    const input = {
      scores: [
        run('a', 1, 9.13), run('b', 1, 9.13), run('c', 1, 9.5),
        run('a', 2, 8.4), run('b', 2, 8.4), run('c', 2, 9.1),
      ],
      scoring_config: TIMED,
      num_go_rounds: 2,
    };
    assert.deepEqual(computeResults(input), computeResults(input));
  });
});
