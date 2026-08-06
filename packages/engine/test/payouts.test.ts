import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateDayMoney,
  calculateFees,
  calculateIPRAThreeHead,
  calculateMultiRoundPayout,
  calculatePESIBonus,
  calculatePayout,
  calculateStockContractorPay,
  findPayoutRule,
  validatePayoutRule,
} from '../src/payouts/engine.ts';
import { applyWithholding } from '../src/payouts/withholding.ts';
import { allocate, toCents } from '../src/money.ts';
import type {
  Entryish,
  PayoutConfig,
  Rankable,
} from '../src/types/index.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JACKPOT: PayoutConfig = {
  fee_structure: { admin_pct: 0.06, office_fee_flat: 500 },
  payout_rules: [
    { min_entries: 1, max_entries: 3, places_paid: 1, splits: [1.0] },
    { min_entries: 4, max_entries: 6, places_paid: 2, splits: [0.6, 0.4] },
    { min_entries: 7, max_entries: 12, places_paid: 3, splits: [0.5, 0.3, 0.2] },
    {
      min_entries: 13,
      max_entries: 20,
      places_paid: 4,
      splits: [0.4, 0.3, 0.2, 0.1],
    },
  ],
  ground_money_rule: 'combine_and_split',
  no_ground_money: false,
  tie_resolution: 'combine_and_split',
};

const COWBOY_RULES: PayoutConfig = {
  ...JACKPOT,
  ground_money_rule: 'none',
  no_ground_money: true,
};

const entries = (n: number): Entryish[] =>
  Array.from({ length: n }, (_, i) => ({
    contestant_id: `c${i + 1}`,
    status: 'confirmed',
  }));

const timed = (id: string, t: number | null, status = 'official'): Rankable => ({
  contestant_id: id,
  status: status as Rankable['status'],
  final_time: t,
  final_score: null,
});

const sumOf = (lines: { amount_cents: number }[]) =>
  lines.reduce((s, l) => s + l.amount_cents, 0);

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

describe('calculateFees', () => {
  it('takes a percentage of the purse plus a flat charge per entry', () => {
    // 10 entries at $50 = $500 entry pool, plus $500 added = $1000 gross.
    const fees = calculateFees(toCents(1000), 10, JACKPOT);
    assert.equal(fees.admin_fee_cents, 6000); // 6% of $1000
    assert.equal(fees.office_fee_cents, 5000); // $5 x 10
    assert.equal(fees.total_cents, 11000);
  });

  it('reports where each fee goes', () => {
    const fees = calculateFees(toCents(1000), 10, {
      ...JACKPOT,
      fee_structure: { cres_fee: 500, sports_medicine_fee: 500 },
    });
    const dests = new Map(fees.destinations.map((d) => [d.type, d.destination]));
    assert.equal(dests.get('cres'), 'cpra_central');
    assert.equal(dests.get('sports_medicine'), 'association');
  });
});

describe('findPayoutRule / validatePayoutRule', () => {
  it('selects the bracket the entry count falls in', () => {
    assert.equal(findPayoutRule(2, JACKPOT)!.places_paid, 1);
    assert.equal(findPayoutRule(5, JACKPOT)!.places_paid, 2);
    assert.equal(findPayoutRule(9, JACKPOT)!.places_paid, 3);
    assert.equal(findPayoutRule(500, JACKPOT), null);
  });

  it('catches splits that do not sum to one', () => {
    const issues = validatePayoutRule({
      min_entries: 1,
      max_entries: 9,
      places_paid: 3,
      splits: [0.5, 0.3, 0.1],
    });
    assert.ok(issues.some((i) => i.code === 'SPLITS_DO_NOT_SUM'));
  });

  it('catches a split list that is the wrong length', () => {
    const issues = validatePayoutRule({
      min_entries: 1,
      max_entries: 9,
      places_paid: 3,
      splits: [0.6, 0.4],
    });
    assert.ok(issues.some((i) => i.code === 'SPLITS_LENGTH_MISMATCH'));
  });
});

// ---------------------------------------------------------------------------
// Standard payout
// ---------------------------------------------------------------------------

describe('calculatePayout', () => {
  it('pays a full field 50/30/20 and reconciles to the cent', () => {
    const result = calculatePayout({
      payout_config: JACKPOT,
      scoring_mode: 'timed',
      entries: entries(10),
      added_money_cents: toCents(500),
      entry_fee_cents: toCents(50),
      results: [
        timed('c1', 9.1),
        timed('c2', 8.7),
        timed('c3', 10.4),
        timed('c4', 11.0),
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.gross_purse_cents, toCents(1000));
    assert.equal(result.net_purse_cents, toCents(1000) - 11000);
    assert.equal(
      sumOf(result.payouts) + result.unpaid_cents + result.escrow_cents,
      result.net_purse_cents,
      'every cent of the net purse is accounted for',
    );

    const byId = new Map(result.payouts.map((p) => [p.contestant_id, p]));
    assert.equal(byId.get('c2')!.place, 1);
    assert.equal(byId.get('c1')!.place, 2);
    assert.equal(byId.get('c3')!.place, 3);
    assert.equal(byId.has('c4'), false, '4th place is out of the money');
  });

  it('reconciles across a thousand awkward purses', () => {
    for (let added = 0; added < 1000; added++) {
      const result = calculatePayout({
        payout_config: JACKPOT,
        scoring_mode: 'timed',
        entries: entries(9),
        added_money_cents: added,
        entry_fee_cents: 4567,
        results: [timed('c1', 9.1), timed('c2', 8.7), timed('c3', 10.4)],
      });
      assert.equal(
        sumOf(result.payouts) + result.unpaid_cents,
        result.net_purse_cents,
        `lost a cent with added=${added}`,
      );
    }
  });

  // Regression for SPEC-DELTAS D2: a runner-up behind a tie for first must not
  // be paid the second-place split.
  it('combines and splits the money for tied places', () => {
    const result = calculatePayout({
      payout_config: JACKPOT,
      scoring_mode: 'timed',
      entries: entries(10),
      added_money_cents: 0,
      entry_fee_cents: toCents(100),
      // Two tied for first, one third. 3 places paid: 50/30/20.
      results: [timed('c1', 9.1), timed('c2', 9.1), timed('c3', 9.5)],
    });

    const net = result.net_purse_cents;
    const byId = new Map(result.payouts.map((p) => [p.contestant_id, p]));

    // 1st and 2nd money combined (0.8 of the purse) split two ways.
    const combined = Math.round(net * 0.8);
    assert.equal(
      byId.get('c1')!.amount_cents + byId.get('c2')!.amount_cents,
      combined,
    );
    assert.equal(byId.get('c1')!.place, 1);
    assert.equal(byId.get('c2')!.place, 1);

    // The next contestant takes THIRD money, not second.
    assert.equal(byId.get('c3')!.place, 3);
    assert.equal(byId.get('c3')!.amount_cents, net - combined);
    assert.equal(sumOf(result.payouts), net);
  });

  it('spreads ground money over the qualified when places go unfilled', () => {
    const result = calculatePayout({
      payout_config: JACKPOT,
      scoring_mode: 'timed',
      entries: entries(10), // 3 places paid
      added_money_cents: 0,
      entry_fee_cents: toCents(100),
      results: [timed('c1', 9.1), timed('c2', 9.5)], // only two caught
    });

    const net = result.net_purse_cents;
    assert.equal(sumOf(result.payouts), net, 'the whole purse still goes out');
    assert.equal(result.unpaid_cents, 0);

    const byId = new Map(result.payouts.map((p) => [p.contestant_id, p]));
    // 20% of the purse (unfilled 3rd) split evenly as ground money.
    const groundTotal =
      byId.get('c1')!.ground_money_cents + byId.get('c2')!.ground_money_cents;
    assert.equal(groundTotal, net - Math.round(net * 0.8));
    assert.ok(byId.get('c1')!.prize_cents > byId.get('c2')!.prize_cents);
  });

  it('leaves unfilled places unpaid under cowboy rules', () => {
    const result = calculatePayout({
      payout_config: COWBOY_RULES,
      scoring_mode: 'timed',
      entries: entries(10),
      added_money_cents: 0,
      entry_fee_cents: toCents(100),
      results: [timed('c1', 9.1), timed('c2', 9.5)],
    });

    const net = result.net_purse_cents;
    assert.ok(result.unpaid_cents > 0, 'the unfilled place is not paid out');
    assert.equal(sumOf(result.payouts) + result.unpaid_cents, net);
    for (const line of result.payouts) {
      assert.equal(line.ground_money_cents, 0);
    }
  });

  it('escrows the purse when nobody qualifies and the config says to', () => {
    const result = calculatePayout({
      payout_config: { ...JACKPOT, escrow_on_no_qualified: true },
      scoring_mode: 'timed',
      entries: entries(10),
      added_money_cents: 0,
      entry_fee_cents: toCents(100),
      results: [timed('c1', null, 'no_time'), timed('c2', null, 'no_time')],
    });

    assert.equal(result.ok, true);
    assert.equal(result.payouts.length, 0);
    assert.equal(result.escrow_cents, result.net_purse_cents);
    assert.ok(result.issues.some((i) => i.code === 'ESCROWED_NO_QUALIFIED'));
  });

  it('flags for a manual decision when nobody qualifies and there is no escrow rule', () => {
    const result = calculatePayout({
      payout_config: JACKPOT,
      scoring_mode: 'timed',
      entries: entries(10),
      added_money_cents: 0,
      entry_fee_cents: toCents(100),
      results: [timed('c1', null, 'no_time')],
    });
    assert.equal(result.escrow_cents, 0);
    assert.equal(result.unpaid_cents, result.net_purse_cents);
    assert.ok(result.issues.some((i) => i.code === 'NO_QUALIFIED'));
  });

  it('refuses to run when no rule covers the entry count', () => {
    const result = calculatePayout({
      payout_config: JACKPOT,
      scoring_mode: 'timed',
      entries: entries(400),
      added_money_cents: 0,
      entry_fee_cents: toCents(100),
      results: [timed('c1', 9.1)],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'NO_MATCHING_RULE'));
  });

  it('refuses to run when the fees would exceed the purse', () => {
    const result = calculatePayout({
      payout_config: {
        ...JACKPOT,
        fee_structure: { admin_pct: 0.5, office_fee_flat: 100000 },
      },
      scoring_mode: 'timed',
      entries: entries(10),
      added_money_cents: 0,
      entry_fee_cents: 100,
      results: [timed('c1', 9.1)],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'FEES_EXCEED_PURSE'));
  });

  it('counts only confirmed and drawn entries toward the purse', () => {
    const mixed: Entryish[] = [
      { contestant_id: 'c1', status: 'confirmed' },
      { contestant_id: 'c2', status: 'drawn' },
      { contestant_id: 'c3', status: 'scratched' },
      { contestant_id: 'c4', status: 'turned_out' },
      { contestant_id: 'c5', status: 'pending' },
    ];
    const result = calculatePayout({
      payout_config: JACKPOT,
      scoring_mode: 'timed',
      entries: mixed,
      added_money_cents: 0,
      entry_fee_cents: toCents(100),
      results: [timed('c1', 9.1)],
    });
    assert.equal(result.gross_purse_cents, toCents(200));
  });

  it('is idempotent — the same inputs pay the same cents', () => {
    const input = {
      payout_config: JACKPOT,
      scoring_mode: 'timed' as const,
      entries: entries(11),
      added_money_cents: 73919,
      entry_fee_cents: 8333,
      results: [timed('c1', 9.1), timed('c2', 9.1), timed('c3', 9.5)],
    };
    assert.deepEqual(calculatePayout(input), calculatePayout(input));
  });
});

// ---------------------------------------------------------------------------
// D-format
// ---------------------------------------------------------------------------

describe('calculatePayout — D-format', () => {
  const D_CONFIG: PayoutConfig = {
    ...JACKPOT,
    fee_structure: {},
    is_d_format: true,
    d_format: {
      divisions: 4,
      time_splits: [0, 0.5, 1.0, 2.0],
      division_pcts: [0.35, 0.3, 0.2, 0.15],
    },
  };

  it('pays each division out of its own share', () => {
    const result = calculatePayout({
      payout_config: D_CONFIG,
      scoring_mode: 'timed',
      entries: entries(8),
      added_money_cents: 0,
      entry_fee_cents: toCents(100),
      results: [
        timed('c1', 15.0),
        timed('c2', 15.3),
        timed('c3', 15.8),
        timed('c4', 16.4),
        timed('c5', 17.5),
      ],
    });

    assert.equal(result.ok, true);
    const divisions = new Set(result.payouts.map((p) => p.d_division));
    assert.ok(divisions.size >= 3, 'more than one division was paid');
    assert.equal(
      sumOf(result.payouts) + result.unpaid_cents,
      result.net_purse_cents,
    );
  });

  it('redistributes an empty division rather than stranding the money', () => {
    const result = calculatePayout({
      payout_config: D_CONFIG,
      scoring_mode: 'timed',
      entries: entries(8),
      added_money_cents: 0,
      entry_fee_cents: toCents(100),
      // All within 0.4s of each other: everybody is in 1D.
      results: [timed('c1', 15.0), timed('c2', 15.2), timed('c3', 15.4)],
    });

    assert.equal(sumOf(result.payouts), result.net_purse_cents);
    assert.ok(result.payouts.every((p) => p.d_division === 1));
  });
});

// ---------------------------------------------------------------------------
// Multi-round
// ---------------------------------------------------------------------------

describe('calculateMultiRoundPayout', () => {
  const TWO_ROUND: PayoutConfig = {
    ...JACKPOT,
    fee_structure: {},
    go_round_average_split: { go_round_pct: 0.4, average_pct: 0.6 },
  };

  it('splits the purse between the go-rounds and the average', () => {
    const result = calculateMultiRoundPayout({
      payout_config: TWO_ROUND,
      scoring_mode: 'timed',
      entries: entries(10),
      added_money_cents: 0,
      entry_fee_cents: toCents(100),
      results_by_round: new Map([
        [1, [timed('c1', 9.1), timed('c2', 8.7), timed('c3', 10.4)]],
        [2, [timed('c1', 8.9), timed('c2', 9.9), timed('c3', 9.2)]],
      ]),
      average_results: [timed('c1', 18.0), timed('c2', 18.6), timed('c3', 19.6)],
    });

    assert.equal(result.ok, true);
    assert.equal(
      sumOf(result.payouts) + result.unpaid_cents,
      result.net_purse_cents,
    );

    // Asserted against the engine's own largest-remainder allocation, not
    // against Math.round: the two can legitimately differ by a cent, and it is
    // the allocation that has to reconcile.
    const [expectedGoRound, expectedAverage] = allocate(result.net_purse_cents, [
      0.4, 0.6,
    ]);
    const goRoundTotal = sumOf(result.payouts.filter((p) => p.type === 'go_round'));
    const averageTotal = sumOf(result.payouts.filter((p) => p.type === 'average'));
    assert.equal(goRoundTotal, expectedGoRound);
    assert.equal(averageTotal, expectedAverage);
    assert.equal(goRoundTotal + averageTotal, result.net_purse_cents);

    assert.deepEqual(
      [...new Set(result.payouts.filter((p) => p.go_round).map((p) => p.go_round))].sort(),
      [1, 2],
    );
  });

  it('needs a go-round/average split to run', () => {
    const result = calculateMultiRoundPayout({
      payout_config: JACKPOT,
      scoring_mode: 'timed',
      entries: entries(10),
      added_money_cents: 0,
      entry_fee_cents: toCents(100),
      results_by_round: new Map([[1, [timed('c1', 9.1)]]]),
      average_results: [timed('c1', 9.1)],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'MISSING_SPLIT'));
  });
});

describe('calculateIPRAThreeHead', () => {
  it('sets aside the short go and splits the rest 2:2:3', () => {
    const total = toCents(10000);
    const numEntries = 40;
    const result = calculateIPRAThreeHead(
      total,
      numEntries,
      new Map([
        [1, [timed('c1', 9.1), timed('c2', 8.7)]],
        [2, [timed('c1', 8.9), timed('c2', 9.9)]],
      ]),
      [timed('c1', 18.0), timed('c2', 18.6)],
      { min_entries: 1, max_entries: 99, places_paid: 2, splits: [0.6, 0.4] },
      JACKPOT,
      'timed',
    );

    assert.equal(result.pools.short_go, 2500 * numEntries); // $25/entry
    const remaining = total - result.pools.short_go;
    assert.equal(
      result.pools.go_round_1 + result.pools.go_round_2 + result.pools.average,
      remaining,
    );
    assert.equal(result.pools.go_round_1, result.pools.go_round_2);
    assert.equal(
      sumOf(result.payouts) + result.unpaid_cents,
      remaining,
    );
  });
});

// ---------------------------------------------------------------------------
// Day money, stock contractors, PESI
// ---------------------------------------------------------------------------

describe('calculateDayMoney', () => {
  it('does not apply to a single-performance rodeo', () => {
    const r = calculateDayMoney({
      is_roughstock: true,
      num_performances: 1,
      additional_entry_fee_cents: toCents(25),
      paid_performance_entries: 20,
      performance_results: [timed('c1', 9.1)],
    });
    assert.equal(r.applies, false);
  });

  it('does not apply to timed events', () => {
    const r = calculateDayMoney({
      is_roughstock: false,
      num_performances: 3,
      additional_entry_fee_cents: toCents(25),
      paid_performance_entries: 20,
      performance_results: [timed('c1', 9.1)],
    });
    assert.equal(r.applies, false);
  });

  it('splits half the additional fees among the qualified rides', () => {
    const r = calculateDayMoney({
      is_roughstock: true,
      num_performances: 3,
      additional_entry_fee_cents: toCents(25),
      paid_performance_entries: 20,
      performance_results: [timed('c1', 9.1), timed('c2', 9.5)],
    });
    assert.equal(r.applies, true);
    assert.equal(r.pool_cents, toCents(250)); // half of 20 x $25
    assert.equal(sumOf(r.payouts), r.pool_cents);
    assert.equal(r.payouts.length, 2);
  });

  it('rolls over when no ride qualified', () => {
    const r = calculateDayMoney({
      is_roughstock: true,
      num_performances: 3,
      additional_entry_fee_cents: toCents(25),
      paid_performance_entries: 20,
      performance_results: [timed('c1', null, 'no_time')],
    });
    assert.equal(r.rollover, true);
    assert.equal(r.payouts.length, 0);
  });
});

describe('calculateStockContractorPay', () => {
  it('splits the contractor share by head supplied', () => {
    const lines = calculateStockContractorPay(
      [
        {
          contestant_id: 'c1',
          type: 'prize',
          amount_cents: toCents(1000),
          prize_cents: toCents(1000),
          ground_money_cents: 0,
        },
      ],
      { ...JACKPOT, stock_contractor_pct: 0.3 },
      new Map([
        ['contractorA', 6],
        ['contractorB', 4],
      ]),
    );

    assert.equal(sumOf(lines), toCents(300));
    const byId = new Map(lines.map((l) => [l.contestant_id, l.amount_cents]));
    assert.equal(byId.get('contractorA'), toCents(180));
    assert.equal(byId.get('contractorB'), toCents(120));
    // Every line names a payee, so every line is disbursable.
    assert.ok(lines.every((l) => l.contestant_id !== null));
  });

  it('pays nothing when the config sets no contractor percentage', () => {
    const lines = calculateStockContractorPay(
      [],
      JACKPOT,
      new Map([['contractorA', 6]]),
    );
    assert.deepEqual(lines, []);
  });
});

describe('calculatePESIBonus', () => {
  it('splits 60/40 between offspring and stallion owners', () => {
    const lines = calculatePESIBonus(toCents(1000), {
      pesi_enrolled: true,
      contractor_id: 'owner',
      sire_contractor_id: 'stallionOwner',
    });
    assert.equal(sumOf(lines), toCents(1000));
    assert.equal(lines[0].amount_cents, toCents(600));
    assert.equal(lines[1].amount_cents, toCents(400));
    assert.equal(lines[1].contestant_id, 'stallionOwner');
  });

  it('pays nothing for an unenrolled animal', () => {
    assert.deepEqual(
      calculatePESIBonus(toCents(1000), {
        pesi_enrolled: false,
        contractor_id: 'owner',
        sire_contractor_id: 'stallionOwner',
      }),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Withholding
// ---------------------------------------------------------------------------

describe('applyWithholding', () => {
  it('withholds nothing from a domestic payout', () => {
    const r = applyWithholding(toCents(1000), {
      contestant_country: 'US',
      rodeo_country: 'US',
    });
    assert.equal(r.withholding_cents, 0);
    assert.equal(r.net_cents, toCents(1000));
    assert.equal(r.advisory, null);
  });

  it('withholds 15% from a US contestant winning in Canada', () => {
    const r = applyWithholding(toCents(1000), {
      contestant_country: 'US',
      rodeo_country: 'CA',
    });
    assert.equal(r.rate, 0.15);
    assert.equal(r.withholding_cents, toCents(150));
    assert.equal(r.net_cents, toCents(850));
    assert.equal(r.rule!.form, 'T4A-NR');
    assert.ok(r.advisory, 'the advisory is always surfaced');
  });

  it('honours a CRA waiver', () => {
    const r = applyWithholding(toCents(1000), {
      contestant_country: 'US',
      rodeo_country: 'CA',
      exemptions: ['waiver_approved'],
    });
    assert.equal(r.withholding_cents, 0);
    assert.equal(r.exemption_applied, 'waiver_approved');
    assert.ok(r.advisory, 'the advisory still shows');
  });

  it('applies Australian PAYG to a resident who did not quote an ABN', () => {
    const r = applyWithholding(toCents(1000), {
      contestant_country: 'AU',
      rodeo_country: 'AU',
      abn_quoted: false,
    });
    assert.equal(r.rate, 0.47);
    assert.equal(r.withholding_cents, toCents(470));
  });

  it('withholds nothing in Australia once an ABN is quoted', () => {
    const r = applyWithholding(toCents(1000), {
      contestant_country: 'AU',
      rodeo_country: 'AU',
      abn_quoted: true,
    });
    assert.equal(r.withholding_cents, 0);
  });

  it('uses the Brazilian tax-haven rate where it applies', () => {
    const r = applyWithholding(toCents(1000), {
      contestant_country: 'US',
      rodeo_country: 'BR',
      tax_haven_resident: true,
    });
    assert.equal(r.rate, 0.25);
    assert.equal(r.withholding_cents, toCents(250));
  });

  it('never nets to less than gross minus withholding', () => {
    for (let cents = 1; cents <= 2000; cents++) {
      const r = applyWithholding(cents, {
        contestant_country: 'US',
        rodeo_country: 'CA',
      });
      assert.equal(r.withholding_cents + r.net_cents, cents);
    }
  });
});
