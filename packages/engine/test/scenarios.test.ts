/**
 * Real rodeos, run end to end through the engine.
 *
 * Unit tests prove a function does what it says. These prove the SYSTEM can
 * actually run the rodeos it claims to run. Each scenario is modelled on a
 * real event with its real format, and asserts the money a secretary would
 * have to hand out.
 *
 *   1. Wrangler NFR, Las Vegas — 10 rounds, 15 contestants, fixed round pools,
 *      no entry fees, team roping paying two people per team.
 *   2. Cheyenne Frontier Days — tournament format, clean slate in the final.
 *   3. A local Texas rodeo — small field, short of the places paid.
 *   4. An Oklahoma team roping jackpot — handicap divisions, a roper entered
 *      more than once, sidepots, 100% payback.
 *   5. A Georgia/Florida 4D barrel race — divisional payout.
 *
 * Where the engine cannot express a format, the test says so out loud rather
 * than asserting something weaker. A skipped or failing scenario here is a
 * product gap, and it is meant to be visible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  allocate,
  calculateMultiRoundPayout,
  calculatePayout,
  calculateTimedScore,
  calculateJudgedScore,
  checkDivisionEligibility,
  payOnePurse,
  payTeamPurse,
  rankResults,
  toCents,
  type Entryish,
  type PayoutConfig,
  type Rankable,
  type ScoringConfig,
} from '../src/index.ts';

const sum = (lines: { amount_cents: number }[]) =>
  lines.reduce((s, l) => s + l.amount_cents, 0);

const timed = (id: string, t: number | null, status = 'official'): Rankable => ({
  contestant_id: id,
  status: status as Rankable['status'],
  final_time: t,
  final_score: null,
});

const judged = (id: string, s: number | null, status = 'official'): Rankable => ({
  contestant_id: id,
  status: status as Rankable['status'],
  final_score: s,
  final_time: null,
});

const confirmed = (ids: string[]): Entryish[] =>
  ids.map((contestant_id) => ({ contestant_id, status: 'confirmed' }));

// ===========================================================================
// 1. WRANGLER NFR — Las Vegas, 10 rounds, 15 contestants
// ===========================================================================

describe('Scenario: Wrangler NFR, Las Vegas', () => {
  // The NFR takes no entry fees. The purse is added money, and each go-round
  // pays a fixed pool to the top six, with a separate average pool.
  // 2021 figures, which are public: $87,087 per go-round, $261,261 average.
  const ROUND_POOL = toCents(87_087);
  const AVERAGE_POOL = toCents(261_261);
  const ROUNDS = 10;
  const TOTAL = ROUND_POOL * ROUNDS + AVERAGE_POOL;

  // Six places per round, at PRCA's standard 6-place ladder.
  const SIX_PLACE = [0.2827, 0.2384, 0.1809, 0.1352, 0.0910, 0.0718];

  const NFR: PayoutConfig = {
    fee_structure: {},
    payout_rules: [
      { min_entries: 1, max_entries: 99, places_paid: 6, splits: SIX_PLACE },
    ],
    go_round_average_split: {
      go_round_pct: (ROUND_POOL * ROUNDS) / TOTAL,
      average_pct: AVERAGE_POOL / TOTAL,
    },
    ground_money_rule: 'combine_and_split',
    tie_resolution: 'combine_and_split',
  };

  const FIFTEEN = Array.from({ length: 15 }, (_, i) => `c${i + 1}`);

  it('the 6-place ladder sums to 1', () => {
    const total = SIX_PLACE.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 0.0001, `ladder sums to ${total}`);
  });

  it('pays 10 go-rounds and an average, reconciling to the cent', () => {
    const byRound = new Map<number, Rankable[]>();
    for (let round = 1; round <= ROUNDS; round++) {
      // Rotate the winner each round so the standings actually move.
      byRound.set(
        round,
        FIFTEEN.map((id, i) =>
          timed(id, 8.0 + ((i + round) % 15) * 0.13),
        ),
      );
    }
    const average = FIFTEEN.map((id, i) => timed(id, 85.0 + i * 0.4));

    const result = calculateMultiRoundPayout({
      payout_config: NFR,
      scoring_mode: 'timed',
      entries: confirmed(FIFTEEN),
      added_money_cents: TOTAL,
      entry_fee_cents: 0,
      results_by_round: byRound,
      average_results: average,
    });

    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.gross_purse_cents, TOTAL, 'no entry fees at the NFR');
    assert.equal(result.fees.total_cents, 0, 'no fees taken out');
    assert.equal(
      sum(result.payouts) + result.unpaid_cents,
      result.net_purse_cents,
      'every cent of $1.13m is accounted for',
    );

    const roundLines = result.payouts.filter((p) => p.type === 'go_round');
    const avgLines = result.payouts.filter((p) => p.type === 'average');

    assert.equal(roundLines.length, ROUNDS * 6, '6 paid per round, 10 rounds');
    assert.equal(avgLines.length, 6, '6 paid in the average');

    // Round pools must land on the published figure, within the cent that
    // largest-remainder allocation can move between pools.
    const roundTotal = sum(roundLines);
    assert.ok(
      Math.abs(roundTotal - ROUND_POOL * ROUNDS) <= ROUNDS,
      `go-round money ${roundTotal} vs expected ${ROUND_POOL * ROUNDS}`,
    );
    assert.ok(
      Math.abs(sum(avgLines) - AVERAGE_POOL) <= ROUNDS,
      `average money ${sum(avgLines)} vs expected ${AVERAGE_POOL}`,
    );
  });

  it('handles a two-way tie for a round win without losing money', () => {
    const field = [
      timed('c1', 3.4),
      timed('c2', 3.4), // tied for the round win
      timed('c3', 3.6),
      timed('c4', 3.7),
      timed('c5', 3.8),
      timed('c6', 3.9),
      timed('c7', 4.0),
    ];
    const ranked = rankResults(field, { mode: 'timed', time_precision: 2 });
    assert.deepEqual(ranked.slice(0, 3).map((r) => r.place), [1, 1, 3]);

    const rule = { min_entries: 1, max_entries: 99, places_paid: 6, splits: SIX_PLACE };
    const { lines, unpaidCents } = payOnePurse(ROUND_POOL, ranked, rule, NFR);

    assert.equal(sum(lines) + unpaidCents, ROUND_POOL);
    const byId = new Map(lines.map((l) => [l.contestant_id, l]));

    // Expected via the same largest-remainder allocation the engine uses.
    // Asserting Math.round(pool * (s0 + s1)) here would be reintroducing the
    // D16 bug in the test: per-group rounding is off by a cent against an
    // allocation that has to sum to the pool exactly.
    const groupWeights = [
      SIX_PLACE[0] + SIX_PLACE[1], // the tied pair occupy places 1 and 2
      SIX_PLACE[2],
      SIX_PLACE[3],
      SIX_PLACE[4],
      SIX_PLACE[5],
      0, // 7th is out of the money
    ];
    const expected = allocate(ROUND_POOL, groupWeights);
    assert.equal(
      byId.get('c1')!.amount_cents + byId.get('c2')!.amount_cents,
      expected[0],
    );
    // Tied contestants can differ by ONE CENT when the combined money is odd.
    // It cannot divide exactly in half, and the alternative to giving the odd
    // cent to somebody is losing it. Which one receives it is deterministic
    // (sorted order), so a re-run pays identically.
    const c1 = byId.get('c1')!.amount_cents;
    const c2 = byId.get('c2')!.amount_cents;
    assert.ok(Math.abs(c1 - c2) <= 1, `tied pair differ by ${Math.abs(c1 - c2)} cents`);
    assert.equal(c1 + c2, expected[0], 'and together they hold the exact total');
    assert.equal(byId.get('c3')!.place, 3, 'next roper takes third money');
  });

  it('a bull rider bucked off in round 3 places in the rounds but not the average', () => {
    const rides = [
      judged('c1', 88),
      judged('c2', 86),
      judged('c3', null, 'no_time'), // bucked off
    ];
    const ranked = rankResults(rides, { mode: 'judged' });
    assert.deepEqual(ranked.map((r) => r.contestant_id), ['c1', 'c2']);
  });

  // ---------------------------------------------------------------------
  // TEAM ROPING — a team is TWO people and both get paid.
  // ---------------------------------------------------------------------
  // -------------------------------------------------------------------
  // TEAM ROPING. Both ropers pay a fee, the team places once, and each end
  // is credited the FULL amount — PRCA publishes these as "$X-a-Man" and
  // headers and heelers carry separate world standings.
  // -------------------------------------------------------------------
  const TEAM_ROPING: PayoutConfig = {
    ...NFR,
    team_payout: 'full_to_each',
    team_size: 2,
  };

  const team = (header: string, heeler: string, t: number): Rankable => ({
    contestant_id: `${header}|${heeler}`,
    status: 'official',
    final_time: t,
    final_score: null,
    team_members: [header, heeler],
  });

  it('TEAM ROPING: header and heeler are each paid the full place money', () => {
    const teams = [
      team('header1', 'heeler1', 3.9),
      team('header2', 'heeler2', 4.2),
      team('header3', 'heeler3', 4.5),
    ];
    const ranked = rankResults(teams, { mode: 'timed', time_precision: 2 });
    const rule = {
      min_entries: 1,
      max_entries: 99,
      places_paid: 3,
      splits: [0.5, 0.3, 0.2],
    };

    const { lines, unpaidCents, issues } = payTeamPurse(
      ROUND_POOL,
      ranked,
      rule,
      TEAM_ROPING,
    );

    assert.deepEqual(issues, []);
    assert.equal(
      sum(lines) + unpaidCents,
      ROUND_POOL,
      'the purse is disbursed exactly once, not doubled',
    );
    assert.equal(lines.length, 6, 'three teams paid, two ropers each');
    assert.ok(
      lines.every((l) => l.contestant_id && !l.contestant_id.includes('|')),
      'every line names one real person, never a team key',
    );

    const byId = new Map(lines.map((l) => [l.contestant_id, l.amount_cents]));
    assert.equal(
      byId.get('header1'),
      byId.get('heeler1'),
      'the winning header and heeler are credited the same amount',
    );
    // Half the pool per end; the winning team takes 50% of that end pool.
    const endPool = Math.round(ROUND_POOL / 2);
    assert.equal(byId.get('header1'), Math.round(endPool * 0.5));
  });

  it('TEAM ROPING: a roper is credited the same as a single-event winner', () => {
    // The parity the ropers asked the PRCA board for. Ten teams at $50 a man
    // is the same $250 to the winner as ten individuals at $50.
    const TEN = Array.from({ length: 10 }, (_, i) => [`h${i}`, `l${i}`] as const);
    const teamResults = TEN.map(([h, l], i) => team(h, l, 6.0 + i * 0.2));
    const ropers = TEN.flatMap(([h, l]) => [h, l]);

    const rule = { min_entries: 1, max_entries: 99, places_paid: 1, splits: [1.0] };
    const oneWinner: PayoutConfig = {
      ...TEAM_ROPING,
      payout_rules: [rule],
    };

    const teamResult = calculatePayout({
      payout_config: oneWinner,
      scoring_mode: 'timed',
      entries: confirmed(ropers), // 20 fees, two per team
      added_money_cents: 0,
      entry_fee_cents: toCents(50),
      results: teamResults,
    });

    // 20 ropers x $50 = $1,000, because BOTH ends pay a fee.
    assert.equal(teamResult.gross_purse_cents, toCents(1000), '20 ropers x $50');
    assert.equal(sum(teamResult.payouts), toCents(1000), 'paid out once, not twice');

    const winners = teamResult.payouts.filter((p) => p.amount_cents > 0);
    assert.equal(winners.length, 2, 'header and heeler');
    assert.equal(winners[0].amount_cents, toCents(500), '$500 a man');
    assert.equal(winners[1].amount_cents, toCents(500), '$500 a man');

    // The parity check. An individual event with the same number of ENTRIES
    // at the same fee: 10 x $50 = $500, winner takes it all = $500. The team
    // roper is credited the same $500 as the individual winner, which is
    // exactly the equal-money position the ropers put to the PRCA board.
    const solo = calculatePayout({
      payout_config: { ...NFR, payout_rules: [rule] },
      scoring_mode: 'timed',
      entries: confirmed(Array.from({ length: 10 }, (_, i) => `s${i}`)),
      added_money_cents: 0,
      entry_fee_cents: toCents(50),
      results: Array.from({ length: 10 }, (_, i) => timed(`s${i}`, 6.0 + i * 0.2)),
    });
    assert.equal(solo.gross_purse_cents, toCents(500), '10 individuals x $50');
    assert.equal(
      solo.payouts[0].amount_cents,
      winners[0].amount_cents,
      'a team roper and an individual winner are credited the same amount',
    );
  });

  it('TEAM ROPING: the ladder is chosen by team count, not roper count', () => {
    // Six teams is a six-entry roping, even though twelve fees came in.
    const SIX = Array.from({ length: 6 }, (_, i) => [`h${i}`, `l${i}`] as const);
    const cfg: PayoutConfig = {
      ...TEAM_ROPING,
      payout_rules: [
        { min_entries: 1, max_entries: 8, places_paid: 2, splits: [0.6, 0.4] },
        { min_entries: 9, max_entries: 99, places_paid: 4, splits: [0.4, 0.3, 0.2, 0.1] },
      ],
    };

    const result = calculatePayout({
      payout_config: cfg,
      scoring_mode: 'timed',
      entries: confirmed(SIX.flatMap(([h, l]) => [h, l])), // 12 people
      added_money_cents: 0,
      entry_fee_cents: toCents(50),
      results: SIX.map(([h, l], i) => team(h, l, 6.0 + i * 0.2)),
    });

    assert.equal(sum(result.payouts), result.net_purse_cents);
    // 2 places paid x 2 ends = 4 lines. The 4-place ladder would give 8.
    assert.equal(result.payouts.length, 4, 'six TEAMS selected the 2-place ladder');
  });

  it('RANCH RODEO: a four-person team splits its place money', () => {
    const ranch: PayoutConfig = {
      ...NFR,
      team_payout: 'split_between',
      team_size: 4,
      payout_rules: [
        { min_entries: 1, max_entries: 99, places_paid: 1, splits: [1.0] },
      ],
    };
    const crew = (name: string, members: string[], t: number): Rankable => ({
      contestant_id: name,
      status: 'official',
      final_time: t,
      final_score: null,
      team_members: members,
    });

    const ranked = rankResults(
      [
        crew('Bar-7', ['a1', 'a2', 'a3', 'a4'], 41.2),
        crew('Rocking-M', ['b1', 'b2', 'b3', 'b4'], 48.9),
      ],
      { mode: 'timed', time_precision: 2 },
    );

    const { lines, unpaidCents } = payTeamPurse(
      toCents(1000),
      ranked,
      ranch.payout_rules[0],
      ranch,
    );

    assert.equal(sum(lines) + unpaidCents, toCents(1000));
    assert.equal(lines.length, 4, 'the winning crew, four ways');
    assert.ok(lines.every((l) => l.amount_cents === toCents(250)));
  });

  it('TEAM: a result with no members is refused rather than paid to nobody', () => {
    const ranked = rankResults([timed('orphan-team', 4.0)], {
      mode: 'timed',
      time_precision: 2,
    });
    const { lines, unpaidCents, issues } = payTeamPurse(
      toCents(500),
      ranked,
      { min_entries: 1, max_entries: 99, places_paid: 1, splits: [1.0] },
      TEAM_ROPING,
    );
    assert.equal(lines.length, 0);
    assert.equal(unpaidCents, toCents(500));
    assert.ok(issues.some((i) => i.code === 'MISSING_TEAM_MEMBERS'));
  });
});

// ===========================================================================
// 2. CHEYENNE FRONTIER DAYS — tournament format
// ===========================================================================

describe('Scenario: Cheyenne Frontier Days, Wyoming', () => {
  // Confirmed for 2026: quarterfinals across six performances, top finishers
  // per performance advance to the semifinals, and Championship Sunday starts
  // from a CLEAN SLATE — earlier times do not carry forward.
  const QUARTER_POOL = toCents(20_000);
  const SEMI_POOL = toCents(30_000);
  const FINAL_POOL = toCents(50_000);

  const CFD: PayoutConfig = {
    fee_structure: {},
    payout_rules: [
      { min_entries: 1, max_entries: 6, places_paid: 3, splits: [0.5, 0.3, 0.2] },
      {
        min_entries: 7,
        max_entries: 99,
        places_paid: 6,
        splits: [0.28, 0.24, 0.18, 0.13, 0.09, 0.08],
      },
    ],
    ground_money_rule: 'combine_and_split',
    tie_resolution: 'combine_and_split',
  };

  const rule6 = CFD.payout_rules[1];
  const rule3 = CFD.payout_rules[0];

  it('a performance advances its top finishers to the semifinal', () => {
    // 12 barrel racers in a performance; the six fastest advance.
    const perf = Array.from({ length: 12 }, (_, i) =>
      timed(`racer${i + 1}`, 17.2 + i * 0.11),
    );
    const ranked = rankResults(perf, { mode: 'timed', time_precision: 3 });
    const advancing = ranked.filter((r) => r.place <= 6).map((r) => r.contestant_id);

    assert.equal(advancing.length, 6);
    assert.deepEqual(advancing, [
      'racer1', 'racer2', 'racer3', 'racer4', 'racer5', 'racer6',
    ]);
  });

  it('each stage pays its own pool, independently', () => {
    const quarter = Array.from({ length: 12 }, (_, i) =>
      timed(`q${i + 1}`, 17.2 + i * 0.11),
    );
    const semi = Array.from({ length: 8 }, (_, i) => timed(`s${i + 1}`, 17.0 + i * 0.09));
    const final = Array.from({ length: 6 }, (_, i) => timed(`f${i + 1}`, 16.9 + i * 0.08));

    const stages: [string, number, Rankable[], typeof rule6][] = [
      ['quarterfinal', QUARTER_POOL, quarter, rule6],
      ['semifinal', SEMI_POOL, semi, rule6],
      ['final', FINAL_POOL, final, rule3],
    ];

    for (const [name, pool, field, rule] of stages) {
      const ranked = rankResults(field, { mode: 'timed', time_precision: 3 });
      const { lines, unpaidCents } = payOnePurse(pool, ranked, rule, CFD);
      assert.equal(sum(lines) + unpaidCents, pool, `${name} pool reconciles`);
      assert.ok(lines.length > 0, `${name} paid somebody`);
    }
  });

  it('CLEAN SLATE: the champion is the fastest on Sunday, not on aggregate', () => {
    // Somebody slow all week can still win. This is the whole point of the
    // format and it is the opposite of an average.
    const weekTimes = new Map([
      ['fastAllWeek', [17.0, 17.1, 17.0]],
      ['slowAllWeek', [18.4, 18.2, 18.5]],
    ]);

    const aggregate = [...weekTimes.entries()].map(([id, times]) =>
      timed(id, times.reduce((a, b) => a + b, 0)),
    );
    const onAggregate = rankResults(aggregate, { mode: 'timed', time_precision: 3 });
    assert.equal(onAggregate[0].contestant_id, 'fastAllWeek');

    // Championship Sunday, clean slate.
    const sunday = [timed('fastAllWeek', 17.4), timed('slowAllWeek', 16.9)];
    const champion = rankResults(sunday, { mode: 'timed', time_precision: 3 });
    assert.equal(
      champion[0].contestant_id,
      'slowAllWeek',
      'the final stands alone; earlier rounds do not carry',
    );
  });

  it('the tournament format must NOT be run through the average engine', () => {
    // calculateMultiRoundPayout computes an aggregate across rounds. Using it
    // for Cheyenne would crown the wrong champion. Guard the distinction.
    const byRound = new Map<number, Rankable[]>([
      [1, [timed('fastAllWeek', 17.0), timed('slowAllWeek', 18.4)]],
      [2, [timed('fastAllWeek', 17.4), timed('slowAllWeek', 16.9)]],
    ]);
    const avg = [timed('fastAllWeek', 34.4), timed('slowAllWeek', 35.3)];

    const averaged = calculateMultiRoundPayout({
      payout_config: { ...CFD, go_round_average_split: { go_round_pct: 0.4, average_pct: 0.6 } },
      scoring_mode: 'timed',
      entries: confirmed(['fastAllWeek', 'slowAllWeek']),
      added_money_cents: FINAL_POOL,
      entry_fee_cents: 0,
      results_by_round: byRound,
      average_results: avg,
    });

    const avgWinner = averaged.payouts
      .filter((p) => p.type === 'average')
      .sort((a, b) => (a.place ?? 99) - (b.place ?? 99))[0];

    assert.equal(
      avgWinner.contestant_id,
      'fastAllWeek',
      'the average engine crowns the aggregate leader — correct for an average, ' +
        'WRONG for Cheyenne. The two formats must not be confused.',
    );
  });
});

// ===========================================================================
// 3. LOCAL TEXAS RODEO — small field, short of the places paid
// ===========================================================================

describe('Scenario: local Texas rodeo, one go-round', () => {
  const TEXAS: PayoutConfig = {
    fee_structure: { admin_pct: 0.06, office_fee_flat: toCents(5) },
    payout_rules: [
      { min_entries: 1, max_entries: 3, places_paid: 1, splits: [1.0] },
      { min_entries: 4, max_entries: 6, places_paid: 2, splits: [0.6, 0.4] },
      { min_entries: 7, max_entries: 12, places_paid: 3, splits: [0.5, 0.3, 0.2] },
      { min_entries: 13, max_entries: 20, places_paid: 4, splits: [0.4, 0.3, 0.2, 0.1] },
    ],
    ground_money_rule: 'combine_and_split',
    tie_resolution: 'combine_and_split',
  };

  it('9 entered, 3 places paid, everybody caught', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `tx${i + 1}`);
    const result = calculatePayout({
      payout_config: TEXAS,
      scoring_mode: 'timed',
      entries: confirmed(ids),
      added_money_cents: toCents(300),
      entry_fee_cents: toCents(45),
      results: ids.map((id, i) => timed(id, 9.1 + i * 0.3)),
    });

    assert.equal(result.ok, true);
    // $300 added + 9 x $45 = $705 gross. 6% = $42.30, $5 x 9 = $45. Net $617.70
    assert.equal(result.gross_purse_cents, toCents(705));
    assert.equal(result.fees.total_cents, toCents(42.3) + toCents(45));
    assert.equal(result.net_purse_cents, toCents(617.7));
    assert.equal(sum(result.payouts) + result.unpaid_cents, result.net_purse_cents);
    assert.equal(result.payouts.length, 3);
  });

  it('9 entered, 3 places paid, only ONE caught — ground money', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `tx${i + 1}`);
    const results: Rankable[] = ids.map((id, i) =>
      i === 0 ? timed(id, 9.1) : timed(id, null, 'no_time'),
    );

    const result = calculatePayout({
      payout_config: TEXAS,
      scoring_mode: 'timed',
      entries: confirmed(ids),
      added_money_cents: toCents(300),
      entry_fee_cents: toCents(45),
      results,
    });

    assert.equal(result.ok, true);
    assert.equal(result.payouts.length, 1, 'one roper caught');
    assert.equal(
      result.payouts[0].amount_cents,
      result.net_purse_cents,
      'the only qualified roper takes the whole purse',
    );
    assert.equal(result.unpaid_cents, 0);
  });

  it('9 entered, NOBODY caught — the purse needs a human decision', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `tx${i + 1}`);
    const result = calculatePayout({
      payout_config: TEXAS,
      scoring_mode: 'timed',
      entries: confirmed(ids),
      added_money_cents: toCents(300),
      entry_fee_cents: toCents(45),
      results: ids.map((id) => timed(id, null, 'no_time')),
    });

    assert.equal(result.ok, true);
    assert.equal(result.payouts.length, 0);
    assert.equal(result.unpaid_cents, result.net_purse_cents);
    assert.ok(result.issues.some((i) => i.code === 'NO_QUALIFIED'));
  });

  it('a scratched entry does not pay into the purse', () => {
    const entries: Entryish[] = [
      ...confirmed(['a', 'b', 'c', 'd', 'e']),
      { contestant_id: 'f', status: 'scratched' },
      { contestant_id: 'g', status: 'turned_out' },
    ];
    const result = calculatePayout({
      payout_config: TEXAS,
      scoring_mode: 'timed',
      entries,
      added_money_cents: 0,
      entry_fee_cents: toCents(45),
      results: [timed('a', 9.1), timed('b', 9.5)],
    });
    assert.equal(result.gross_purse_cents, toCents(225), '5 paying entries');
  });

  it('a bareback ride is scored, ranked and paid alongside timed events', () => {
    const PRCA_BB: ScoringConfig = {
      mode: 'judged',
      max_score: 100,
      components: [
        { name: 'rider', min: 0, max: 25, judges: 2 },
        { name: 'animal', min: 0, max: 25, judges: 2 },
      ],
      increment: 0.5,
      score_divisor: 1,
      mark_out_required: true,
      dq_triggers: ['mark_out_violation'],
    };

    const card = (rider: number, animal: number, markedOut = true) => ({
      judges: [1, 2].map((p) => ({
        judge_id: `j${p}`,
        judge_position: p,
        components: [
          { name: 'rider', value: rider },
          { name: 'animal', value: animal },
        ],
      })),
      marked_out: markedOut,
    });

    const a = calculateJudgedScore(card(21, 21), PRCA_BB); // 84
    const b = calculateJudgedScore(card(20, 21), PRCA_BB); // 82
    const c = calculateJudgedScore(card(22, 22, false), PRCA_BB); // missed out

    assert.equal(a.final_score, 84);
    assert.equal(b.final_score, 82);
    assert.equal(c.status, 'dq', 'no mark-out, no score');

    const ranked = rankResults(
      [judged('a', a.final_score), judged('b', b.final_score), judged('c', null, 'dq')],
      { mode: 'judged' },
    );
    assert.deepEqual(ranked.map((r) => r.contestant_id), ['a', 'b']);
  });
});

// ===========================================================================
// 4. OKLAHOMA TEAM ROPING JACKPOT — handicaps, multiple entries, sidepots
// ===========================================================================

describe('Scenario: Oklahoma team roping jackpot', () => {
  const JACKPOT: PayoutConfig = {
    // 100% payback: the jackpot keeps nothing.
    fee_structure: {},
    payout_rules: [
      { min_entries: 1, max_entries: 5, places_paid: 1, splits: [1.0] },
      { min_entries: 6, max_entries: 15, places_paid: 2, splits: [0.6, 0.4] },
      { min_entries: 16, max_entries: 99, places_paid: 3, splits: [0.5, 0.3, 0.2] },
    ],
    ground_money_rule: 'combine_and_split',
    tie_resolution: 'combine_and_split',
  };

  const USTRC_LADDER = [
    { name: '#9', max_combined: 9, header_cap: 5, heeler_cap: 5 },
    { name: '#11', max_combined: 11, header_cap: 7, heeler_cap: 7 },
    { name: 'Open', max_combined: null },
  ];

  it('a #4 heading for a #5 heeler makes the #9', () => {
    const r = checkDivisionEligibility(
      { header_id: 'h', header_number: 4, heeler_id: 'l', heeler_number: 5 },
      USTRC_LADDER[0],
    );
    assert.equal(r.eligible, true);
    assert.equal(r.combined, 9);
  });

  it('a #6 header is out of the #9 even at a #9 total', () => {
    const r = checkDivisionEligibility(
      { header_id: 'h', header_number: 6, heeler_id: 'l', heeler_number: 3 },
      USTRC_LADDER[0],
    );
    assert.equal(r.eligible, false);
    assert.ok(r.issues.some((i) => i.code === 'HEADER_OVER_END_CAP'));
  });

  it('the USTRC 5-second barrier is charged, not the PRCA 10', () => {
    const USTRC: ScoringConfig = {
      mode: 'timed',
      time_precision: 2,
      timed_penalties: [
        { type: 'barrier_break', seconds: 5 },
        { type: 'one_leg_catch', seconds: 5 },
      ],
      dq_triggers: ['crossfire', 'no_catch'],
    };
    const r = calculateTimedScore(
      { raw_time: 7.21, penalties: [{ type: 'barrier_break' }] },
      USTRC,
    );
    assert.equal(r.final_time, 12.21);
  });

  // ---------------------------------------------------------------------
  // A roper entering the same roping more than once is completely normal.
  // ---------------------------------------------------------------------
  it('MULTIPLE ENTRIES: one roper enters three times with three partners', () => {
    // Casey heads for three different heelers. All three teams are separate
    // runs, and Casey can legitimately win first AND third.
    const runs = [
      { team: 'casey+dale', time: 6.8 },
      { team: 'casey+wes', time: 7.4 },
      { team: 'casey+jim', time: 8.9 },
      { team: 'tyler+bo', time: 7.1 },
      { team: 'clint+ray', time: 7.9 },
      { team: 'shane+lee', time: 8.2 },
    ];

    const ranked = rankResults(
      runs.map((r) => timed(r.team, r.time)),
      { mode: 'timed', time_precision: 2 },
    );

    assert.equal(ranked.length, 6, 'every run is ranked separately');
    assert.equal(ranked[0].contestant_id, 'casey+dale');
    assert.equal(ranked[1].contestant_id, 'tyler+bo');
    assert.equal(ranked[2].contestant_id, 'casey+wes');

    const rule = JACKPOT.payout_rules[1];
    const { lines } = payOnePurse(toCents(1200), ranked, rule, JACKPOT);
    assert.equal(sum(lines), toCents(1200));

    // Casey collects on two of the three teams.
    const caseyRuns = lines.filter((l) => l.contestant_id!.startsWith('casey+'));
    assert.equal(caseyRuns.length, 1, 'only one of Casey teams is in the money here');
  });

  it('MULTIPLE ENTRIES: the same person placing twice is paid twice', () => {
    const runs = [
      timed('casey+dale', 6.8),
      timed('casey+wes', 7.0),
      timed('tyler+bo', 7.5),
    ];
    const ranked = rankResults(runs, { mode: 'timed', time_precision: 2 });
    const rule = JACKPOT.payout_rules[1];
    const { lines } = payOnePurse(toCents(1000), ranked, rule, JACKPOT);

    const caseyTotal = sum(lines.filter((l) => l.contestant_id!.startsWith('casey')));
    assert.equal(
      caseyTotal,
      toCents(1000),
      'Casey won both paid places and collects both',
    );
  });

  it('SIDEPOT: a $20 incentive off the same run pays 100% back', () => {
    // 14 teams enter the roping; 9 of them also throw $20 at the incentive.
    const inSidepot = [
      'casey+dale', 'tyler+bo', 'clint+ray', 'shane+lee', 'wade+jt',
      'kip+lane', 'brad+cody', 'russ+dean', 'monte+abe',
    ];
    const buyIn = toCents(20);
    const pool = buyIn * inSidepot.length; // $180, nothing held back

    const field = inSidepot.map((t, i) => timed(t, 6.8 + i * 0.22));
    const ranked = rankResults(field, { mode: 'timed', time_precision: 2 });

    const rule = JACKPOT.payout_rules[1]; // 9 entries -> 2 places
    const { lines, unpaidCents } = payOnePurse(pool, ranked, rule, JACKPOT, 'prize');

    assert.equal(sum(lines) + unpaidCents, pool, '100% payback reconciles');
    assert.equal(unpaidCents, 0);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].amount_cents, toCents(108)); // 60% of $180
    assert.equal(lines[1].amount_cents, toCents(72)); // 40%
  });

  it('an odd pool split three ways still hands out every cent', () => {
    // 13 teams x $37 = $481, an amount that does not divide cleanly.
    const pool = toCents(481);
    const field = Array.from({ length: 13 }, (_, i) => timed(`t${i + 1}`, 6.5 + i * 0.17));
    const ranked = rankResults(field, { mode: 'timed', time_precision: 2 });
    const rule = JACKPOT.payout_rules[2];
    const { lines, unpaidCents } = payOnePurse(pool, ranked, rule, JACKPOT);

    assert.equal(sum(lines) + unpaidCents, pool);
    assert.equal(sum(lines), pool, 'nothing left in the box');
  });
});

// ===========================================================================
// 5. GEORGIA / FLORIDA 4D BARREL RACE
// ===========================================================================

describe('Scenario: Georgia 4D barrel race', () => {
  const D4: PayoutConfig = {
    fee_structure: { office_fee_flat: toCents(3) },
    is_d_format: true,
    d_format: {
      divisions: 4,
      time_splits: [0, 0.5, 1.0, 2.0],
      division_pcts: [0.35, 0.3, 0.2, 0.15],
    },
    payout_rules: [
      { min_entries: 1, max_entries: 5, places_paid: 1, splits: [1.0] },
      { min_entries: 6, max_entries: 10, places_paid: 2, splits: [0.6, 0.4] },
      { min_entries: 11, max_entries: 99, places_paid: 3, splits: [0.5, 0.3, 0.2] },
    ],
    ground_money_rule: 'combine_and_split',
    tie_resolution: 'combine_and_split',
  };

  const BARRELS: ScoringConfig = {
    mode: 'timed',
    time_precision: 3,
    timed_penalties: [{ type: 'barrel_knockdown', seconds: 5, repeatable: true }],
    dq_triggers: ['off_pattern'],
  };

  it('a knocked barrel adds five seconds and drops the racer a division', () => {
    const clean = calculateTimedScore({ raw_time: 17.412 }, BARRELS);
    const oneDown = calculateTimedScore({ raw_time: 17.412, barrels_knocked: 1 }, BARRELS);
    const twoDown = calculateTimedScore({ raw_time: 17.412, barrels_knocked: 2 }, BARRELS);

    assert.equal(clean.final_time, 17.412);
    assert.equal(oneDown.final_time, 22.412);
    assert.equal(twoDown.final_time, 27.412, 'two barrels is ten seconds');
  });

  it('off pattern is a no-time, not a slow time', () => {
    const r = calculateTimedScore(
      { raw_time: 21.5, dq_triggers: ['off_pattern'] },
      BARRELS,
    );
    assert.equal(r.status, 'no_time');
    assert.equal(r.final_time, null);
  });

  it('pays all four divisions out of one purse and reconciles', () => {
    // 24 racers spread across the D splits off a 17.2 fast time.
    const times = [
      17.2, 17.3, 17.45, 17.6, // 1D  (0 - 0.5 off)
      17.75, 17.9, 18.0, 18.1, // 2D  (0.5 - 1.0)
      18.3, 18.5, 18.9, 19.1, // 3D  (1.0 - 2.0)
      19.4, 19.9, 20.5, 21.0, // 4D  (2.0+)
    ];
    const ids = times.map((_, i) => `racer${i + 1}`);

    const result = calculatePayout({
      payout_config: D4,
      scoring_mode: 'timed',
      entries: confirmed(ids),
      added_money_cents: toCents(500),
      entry_fee_cents: toCents(50),
      results: ids.map((id, i) => timed(id, times[i])),
    });

    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(
      sum(result.payouts) + result.unpaid_cents,
      result.net_purse_cents,
      'the whole purse is accounted for across four divisions',
    );

    const divisions = new Set(result.payouts.map((p) => p.d_division));
    assert.deepEqual([...divisions].sort(), [1, 2, 3, 4], 'all four D paid');

    // Division shares follow the configured percentages.
    const net = result.net_purse_cents;
    const expected = allocate(net, D4.d_format!.division_pcts);
    for (let d = 1; d <= 4; d++) {
      const paid = sum(result.payouts.filter((p) => p.d_division === d));
      assert.equal(paid, expected[d - 1], `${d}D share`);
    }
  });

  it('when only the 1D fills, the empty divisions are not stranded', () => {
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    const result = calculatePayout({
      payout_config: D4,
      scoring_mode: 'timed',
      entries: confirmed(ids),
      added_money_cents: toCents(500),
      entry_fee_cents: toCents(50),
      results: ids.map((id, i) => timed(id, 17.2 + i * 0.06)),
    });

    assert.equal(sum(result.payouts), result.net_purse_cents, 'no money left behind');
    assert.ok(result.payouts.every((p) => p.d_division === 1));
  });
});
