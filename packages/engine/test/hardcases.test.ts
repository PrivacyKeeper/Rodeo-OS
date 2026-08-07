/**
 * The awkward cases.
 *
 * Every one of these is something a secretary hits in a real arena and gets
 * wrong on paper. If the engine cannot be trusted here it cannot be trusted at
 * all, because these are precisely the situations where somebody rings up
 * afterwards asking where their money went.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  allocate,
  calculateAggregate,
  calculateDayMoney,
  calculatePayout,
  calculateTimedScore,
  payOnePurse,
  payTeamPurse,
  rankResults,
  toCents,
  type Entryish,
  type PayoutConfig,
  type Rankable,
  type ScoringConfig,
} from '../src/index.ts';

const sum = (l: { amount_cents: number }[]) =>
  l.reduce((s, x) => s + x.amount_cents, 0);

const timed = (id: string, t: number | null, status = 'official'): Rankable => ({
  contestant_id: id,
  status: status as Rankable['status'],
  final_time: t,
  final_score: null,
});

const confirmed = (ids: string[]): Entryish[] =>
  ids.map((contestant_id) => ({ contestant_id, status: 'confirmed' }));

const LADDER3 = { min_entries: 1, max_entries: 99, places_paid: 3, splits: [0.5, 0.3, 0.2] };

const CFG: PayoutConfig = {
  fee_structure: {},
  payout_rules: [LADDER3],
  ground_money_rule: 'combine_and_split',
  tie_resolution: 'combine_and_split',
};

const rank = (f: Rankable[]) => rankResults(f, { mode: 'timed', time_precision: 2 });

// ===========================================================================
// Ties in every awkward position
// ===========================================================================

describe('ties', () => {
  it('a tie for the LAST paid place splits only that place', () => {
    // 3 places paid; three ropers tie for third.
    const ranked = rank([
      timed('a', 8.0),
      timed('b', 8.5),
      timed('c', 9.0),
      timed('d', 9.0),
      timed('e', 9.0),
    ]);
    assert.deepEqual(ranked.map((r) => r.place), [1, 2, 3, 3, 3]);

    const { lines, unpaidCents } = payOnePurse(toCents(1000), ranked, LADDER3, CFG);
    assert.equal(sum(lines) + unpaidCents, toCents(1000));

    const byId = new Map(lines.map((l) => [l.contestant_id, l.amount_cents]));
    // 3rd place money only — 4th and 5th pay nothing — split three ways.
    const third = toCents(1000) * 0.2;
    assert.equal(
      byId.get('c')! + byId.get('d')! + byId.get('e')!,
      Math.round(third),
    );
  });

  it('a tie spanning PAST the paid places pulls in nothing extra', () => {
    const ranked = rank([timed('a', 8.0), timed('b', 8.0), timed('c', 8.0), timed('d', 8.0)]);
    assert.deepEqual(ranked.map((r) => r.place), [1, 1, 1, 1]);

    const { lines, unpaidCents } = payOnePurse(toCents(999), ranked, LADDER3, CFG);
    assert.equal(sum(lines) + unpaidCents, toCents(999));
    assert.equal(sum(lines), toCents(999), 'all three paid places, four ways');
    assert.equal(lines.length, 4);
    // 333.00 / 333.00 / 333.00 / 333.00 cannot be exact; spread must be 1 cent.
    const amounts = lines.map((l) => l.amount_cents);
    assert.ok(Math.max(...amounts) - Math.min(...amounts) <= 1);
  });

  it('EVERYBODY ties — the whole purse still goes out', () => {
    const ranked = rank(Array.from({ length: 7 }, (_, i) => timed(`c${i}`, 9.0)));
    assert.ok(ranked.every((r) => r.place === 1));
    const { lines, unpaidCents } = payOnePurse(toCents(1000), ranked, LADDER3, CFG);
    assert.equal(sum(lines) + unpaidCents, toCents(1000));
    assert.equal(sum(lines), toCents(1000));
    assert.equal(lines.length, 7);
  });

  it('a tie of two for first, then a tie of two for third', () => {
    const ranked = rank([
      timed('a', 8.0), timed('b', 8.0),
      timed('c', 9.0), timed('d', 9.0),
      timed('e', 9.5),
    ]);
    assert.deepEqual(ranked.map((r) => r.place), [1, 1, 3, 3, 5]);
    const { lines, unpaidCents } = payOnePurse(toCents(1000), ranked, LADDER3, CFG);
    assert.equal(sum(lines) + unpaidCents, toCents(1000));
    const byId = new Map(lines.map((l) => [l.contestant_id, l.amount_cents]));
    assert.equal(byId.get('a'), byId.get('b'));
    assert.equal(byId.get('c'), byId.get('d'));
    assert.equal(byId.has('e'), false, 'fifth is out of the money');
  });

  it('a tie inside a TEAM event still pays every end', () => {
    const team = (h: string, l: string, t: number): Rankable => ({
      contestant_id: `${h}|${l}`,
      status: 'official',
      final_time: t,
      final_score: null,
      team_members: [h, l],
    });
    const ranked = rank([team('h1', 'l1', 6.0), team('h2', 'l2', 6.0)]);
    const cfg: PayoutConfig = { ...CFG, team_payout: 'full_to_each', team_size: 2 };
    const { lines, unpaidCents, issues } = payTeamPurse(
      toCents(1000),
      ranked,
      { min_entries: 1, max_entries: 99, places_paid: 2, splits: [0.6, 0.4] },
      cfg,
    );
    assert.deepEqual(issues, []);
    assert.equal(sum(lines) + unpaidCents, toCents(1000));
    assert.equal(lines.length, 4, 'two teams, two ends each');
    const amounts = lines.map((l) => l.amount_cents);
    assert.ok(Math.max(...amounts) - Math.min(...amounts) <= 1, 'tied teams paid alike');
  });
});

// ===========================================================================
// Money at NFR scale, and money at jackpot scale
// ===========================================================================

describe('money scale', () => {
  it('handles a $17.5 million purse without losing precision', () => {
    const purse = toCents(17_500_000);
    assert.ok(Number.isSafeInteger(purse));
    const ranked = rank(Array.from({ length: 15 }, (_, i) => timed(`c${i}`, 8 + i * 0.1)));
    const { lines, unpaidCents } = payOnePurse(purse, ranked, LADDER3, CFG);
    assert.equal(sum(lines) + unpaidCents, purse, 'not one cent of $17.5m lost');
  });

  it('handles a $12 buckle jackpot', () => {
    const ranked = rank([timed('a', 8.0), timed('b', 8.4)]);
    const { lines, unpaidCents } = payOnePurse(toCents(12), ranked, LADDER3, CFG);
    assert.equal(sum(lines) + unpaidCents, toCents(12));
  });

  it('a one-cent purse goes to somebody', () => {
    const ranked = rank([timed('a', 8.0), timed('b', 8.4)]);
    const { lines, unpaidCents } = payOnePurse(1, ranked, LADDER3, CFG);
    assert.equal(sum(lines) + unpaidCents, 1);
  });

  it('reconciles across ten thousand purse sizes', () => {
    const ranked = rank([
      timed('a', 8.0), timed('b', 8.4), timed('c', 9.0),
      timed('d', 9.4), timed('e', 9.9),
    ]);
    for (let cents = 1; cents <= 10_000; cents++) {
      const { lines, unpaidCents } = payOnePurse(cents, ranked, LADDER3, CFG);
      assert.equal(
        sum(lines) + unpaidCents,
        cents,
        `lost a cent at a purse of ${cents}`,
      );
    }
  });

  it('reconciles for every field size from 1 to 60', () => {
    for (let n = 1; n <= 60; n++) {
      const ranked = rank(
        Array.from({ length: n }, (_, i) => timed(`c${i}`, 8 + i * 0.07)),
      );
      const { lines, unpaidCents } = payOnePurse(toCents(1234.57), ranked, LADDER3, CFG);
      assert.equal(sum(lines) + unpaidCents, toCents(1234.57), `field of ${n}`);
    }
  });
});

// ===========================================================================
// Data the secretary can get wrong
// ===========================================================================

describe('bad or surprising input', () => {
  it('a result for somebody who never entered is still ranked — and that is a hole', () => {
    // The engine ranks what it is given. It does NOT cross-check the results
    // against the entry list, so a mis-keyed contestant id becomes a payee.
    // Documented deliberately: this is caught upstream at the API, where a
    // score can only be written against an existing entry_id.
    const result = calculatePayout({
      payout_config: CFG,
      scoring_mode: 'timed',
      entries: confirmed(['a', 'b']),
      added_money_cents: toCents(100),
      entry_fee_cents: toCents(50),
      results: [timed('a', 8.0), timed('ghost', 7.5)],
    });
    assert.equal(result.ok, true);
    assert.ok(
      result.payouts.some((p) => p.contestant_id === 'ghost'),
      'the engine trusts its results list; the entry FK is what prevents this',
    );
  });

  it('a config whose splits do not sum to 1 is refused, not silently scaled', () => {
    const bad: PayoutConfig = {
      ...CFG,
      payout_rules: [
        { min_entries: 1, max_entries: 99, places_paid: 3, splits: [0.5, 0.3, 0.1] },
      ],
    };
    const result = calculatePayout({
      payout_config: bad,
      scoring_mode: 'timed',
      entries: confirmed(['a', 'b', 'c']),
      added_money_cents: 0,
      entry_fee_cents: toCents(50),
      results: [timed('a', 8.0)],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'SPLITS_DO_NOT_SUM'));
    assert.equal(result.payouts.length, 0, 'nothing is paid on a broken ladder');
  });

  it('fees that eat the whole purse are refused', () => {
    const greedy: PayoutConfig = {
      ...CFG,
      fee_structure: { admin_pct: 0.9, office_fee_flat: toCents(40) },
    };
    const result = calculatePayout({
      payout_config: greedy,
      scoring_mode: 'timed',
      entries: confirmed(['a', 'b']),
      added_money_cents: 0,
      entry_fee_cents: toCents(20),
      results: [timed('a', 8.0)],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'FEES_EXCEED_PURSE'));
  });

  it('an entry count with no matching ladder rung is refused', () => {
    const gapped: PayoutConfig = {
      ...CFG,
      payout_rules: [{ min_entries: 10, max_entries: 20, places_paid: 3, splits: [0.5, 0.3, 0.2] }],
    };
    const result = calculatePayout({
      payout_config: gapped,
      scoring_mode: 'timed',
      entries: confirmed(['a', 'b', 'c']),
      added_money_cents: 0,
      entry_fee_cents: toCents(50),
      results: [timed('a', 8.0)],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'NO_MATCHING_RULE'));
  });

  it('a negative raw time is rejected, not paid', () => {
    const cfg: ScoringConfig = { mode: 'timed', time_precision: 2 };
    const r = calculateTimedScore({ raw_time: -3 }, cfg);
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.code === 'INVALID_TIME'));
  });

  it('a timed config handed a judged run refuses rather than scoring zero', () => {
    const cfg: ScoringConfig = { mode: 'judged', components: [], increment: 0.5 };
    const r = calculateTimedScore({ raw_time: 8.0 }, cfg);
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.code === 'WRONG_MODE'));
  });
});

// ===========================================================================
// Multi-round realities
// ===========================================================================

describe('go-rounds and the average', () => {
  it('a contestant who turned out of round 2 takes no average', () => {
    const agg = calculateAggregate(
      [
        { contestant_id: 'a', go_round: 1, status: 'official', final_time: 9.1 },
        { contestant_id: 'a', go_round: 2, status: 'turned_out', final_time: null },
      ],
      { mode: 'timed', time_precision: 2 },
      2,
    );
    assert.equal(agg!.complete, false);
  });

  it('a three-head average needs all three', () => {
    const two = calculateAggregate(
      [
        { contestant_id: 'a', go_round: 1, status: 'official', final_time: 9.1 },
        { contestant_id: 'a', go_round: 2, status: 'official', final_time: 8.7 },
      ],
      { mode: 'timed', time_precision: 2 },
      3,
    );
    assert.equal(two!.complete, false);

    const three = calculateAggregate(
      [
        { contestant_id: 'a', go_round: 1, status: 'official', final_time: 9.1 },
        { contestant_id: 'a', go_round: 2, status: 'official', final_time: 8.7 },
        { contestant_id: 'a', go_round: 3, status: 'official', final_time: 9.0 },
      ],
      { mode: 'timed', time_precision: 2 },
      3,
    );
    assert.equal(three!.complete, true);
    assert.equal(three!.aggregate_value, 26.8);
  });

  it('day money rolls over when a whole performance goes without a qualified ride', () => {
    const r = calculateDayMoney({
      is_roughstock: true,
      num_performances: 4,
      additional_entry_fee_cents: toCents(30),
      paid_performance_entries: 12,
      performance_results: [
        timed('a', null, 'no_time'),
        timed('b', null, 'no_time'),
      ],
    });
    assert.equal(r.applies, true);
    assert.equal(r.rollover, true);
    assert.equal(r.payouts.length, 0);
    assert.equal(r.pool_cents, toCents(180), 'half of 12 x $30 is held for rollover');
  });

  it('day money splits evenly and exactly among the qualified rides', () => {
    const r = calculateDayMoney({
      is_roughstock: true,
      num_performances: 4,
      additional_entry_fee_cents: toCents(25),
      paid_performance_entries: 7, // odd, so the split is not clean
      performance_results: [timed('a', 8.0), timed('b', 8.1), timed('c', 8.2)],
    });
    assert.equal(sum(r.payouts), r.pool_cents, 'every cent of day money goes out');
    const amounts = r.payouts.map((p) => p.amount_cents);
    assert.ok(Math.max(...amounts) - Math.min(...amounts) <= 1);
  });
});

// ===========================================================================
// Determinism — a re-run must pay identically
// ===========================================================================

describe('determinism', () => {
  it('the same rodeo calculated twice pays byte-identically', () => {
    const build = () =>
      calculatePayout({
        payout_config: CFG,
        scoring_mode: 'timed',
        entries: confirmed(['a', 'b', 'c', 'd', 'e', 'f', 'g']),
        added_money_cents: 77_313,
        entry_fee_cents: 4_567,
        results: [
          timed('a', 8.13), timed('b', 8.13), timed('c', 9.01),
          timed('d', 9.01), timed('e', 9.01), timed('f', 10.4),
        ],
      });
    assert.deepEqual(build(), build());
  });

  it('allocation order does not depend on object identity', () => {
    const a = allocate(100_001, [0.5, 0.3, 0.2]);
    const b = allocate(100_001, [0.5, 0.3, 0.2]);
    assert.deepEqual(a, b);
    assert.equal(a.reduce((s, v) => s + v, 0), 100_001);
  });
});
