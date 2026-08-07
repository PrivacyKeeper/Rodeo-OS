import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPETITORS,
  DEFAULT_PLATFORM_FEES,
  PASS_THROUGH_FEES,
  PRODUCER_PLANS,
  compareModels,
  recommendPlan,
  calculatePlatformFee,
  compareAllIn,
  modelContestant,
  subscriptionBreakEven,
  toCents,
} from '../src/index.ts';

const entry = (dollars: number, subscriber = false) =>
  calculatePlatformFee({ entry_total_cents: toCents(dollars), subscriber });

describe('platform fee', () => {
  it('charges 2% to a non-subscriber', () => {
    const r = entry(100);
    assert.equal(r.platform_fee_cents, toCents(2));
  });

  it('charges a subscriber nothing', () => {
    const r = entry(100, true);
    assert.equal(r.platform_fee_cents, 0);
    assert.equal(r.saved_vs_standard_cents, toCents(2));
  });

  it('never counts the processor cut as our revenue', () => {
    const r = entry(100);
    assert.equal(r.platform_net_cents, r.platform_fee_cents);
    assert.ok(r.processing_fee_cents > 0);
    assert.notEqual(r.platform_net_cents, r.processing_fee_cents);
  });

  it('the processor takes its cut of the platform fee too', () => {
    // A model that charges processing on the entry alone understates cost on
    // every single transaction.
    const r = entry(100);
    const chargedToCard = toCents(100) + r.platform_fee_cents;
    assert.equal(
      r.processing_fee_cents,
      Math.round(chargedToCard * 0.029) + 30,
    );
  });

  it('the producer receives the full entry when the contestant pays fees', () => {
    const r = entry(100);
    assert.equal(r.producer_receives_cents, toCents(100));
    assert.equal(
      r.contestant_pays_cents,
      toCents(100) + r.platform_fee_cents + r.processing_fee_cents,
    );
  });

  it('the producer absorbs processing when configured that way', () => {
    const r = calculatePlatformFee({
      entry_total_cents: toCents(100),
      subscriber: false,
      config: { ...DEFAULT_PLATFORM_FEES, card_fees: 'producer' },
    });
    assert.ok(r.producer_receives_cents < toCents(100));
    assert.equal(
      r.contestant_pays_cents,
      toCents(100) + r.platform_fee_cents,
      'the contestant is not charged processing',
    );
  });

  it('caps the fee so a big entry is not gouged', () => {
    const r = entry(2000); // 2% would be $40
    assert.equal(r.platform_fee_cents, toCents(15), 'capped at $15');
  });

  it('a zero-dollar entry carries no fee at all', () => {
    const r = entry(0);
    assert.equal(r.platform_fee_cents, 0);
    assert.equal(r.processing_fee_cents, 0);
    assert.equal(r.contestant_pays_cents, 0);
  });

  it('refuses a negative total', () => {
    const r = calculatePlatformFee({ entry_total_cents: -100, subscriber: false });
    assert.ok(r.issues.some((i) => i.code === 'NEGATIVE_TOTAL'));
  });
});

describe('competitive position', () => {
  // The claim the whole model rests on. If this ever fails, the rate is wrong.
  it('a non-subscriber pays LESS all-in than RodeoReady, at every entry size', () => {
    for (const size of [25, 50, 100, 150, 300, 500]) {
      const rows = compareAllIn(toCents(size), false);
      const ours = rows.find((r) => r.name === 'RodeoApps')!;
      const theirs = rows.find((r) => r.name === 'RodeoReady')!;
      assert.ok(
        ours.contestant_pays_cents < theirs.contestant_pays_cents,
        `at $${size} we charge ${ours.contestant_pays_cents} vs their ${theirs.contestant_pays_cents}`,
      );
    }
  });

  it('a SUBSCRIBER pays less than every competitor, at every entry size', () => {
    for (const size of [25, 50, 100, 150, 300, 500]) {
      const rows = compareAllIn(toCents(size), true);
      const ours = rows.find((r) => r.name.includes('subscriber'))!;
      for (const other of rows.filter((r) => !r.name.startsWith('RodeoApps'))) {
        assert.ok(
          ours.contestant_pays_cents < other.contestant_pays_cents,
          `at $${size} a subscriber pays ${ours.contestant_pays_cents} vs ${other.name} ${other.contestant_pays_cents}`,
        );
      }
    }
  });

  it('the comparison accounts for who pays card processing', () => {
    // RodeoReady's rate includes it; Rodeo Producer's does not. Comparing the
    // headline numbers without that is how the first draft of this model set
    // the rate 2.5x too high.
    const rr = COMPETITORS.find((c) => c.name === 'RodeoReady')!;
    const rp = COMPETITORS.find((c) => c.name === 'Rodeo Producer')!;
    assert.equal(rr.includes_processing, true);
    assert.equal(rp.includes_processing, false);
  });
});

describe('subscription break-even', () => {
  it('a serious competitor clears it well inside a season', () => {
    assert.ok(subscriptionBreakEven(toCents(150)).entries <= 20);
    assert.ok(subscriptionBreakEven(toCents(100)).entries <= 25);
  });

  it('a weekend jackpot roper does not — and should buy it for the app', () => {
    // Honest: at $50 entries it takes 50 a year. The subscription is not sold
    // as a fee discount to that rider, and the model should not pretend it is.
    assert.ok(subscriptionBreakEven(toCents(50)).entries > 40);
  });

  it('reports the per-entry saving so the pitch is checkable', () => {
    const b = subscriptionBreakEven(toCents(150));
    assert.equal(b.per_entry_saving_cents, toCents(3));
  });
});

describe('revenue model', () => {
  it('a heavy competitor costs LESS as a subscriber than as a payer', () => {
    const paying = modelContestant({
      label: 'pro', entries_per_year: 120,
      avg_entry_cents: toCents(150), subscriber: false,
    });
    const subbed = modelContestant({
      label: 'pro subbed', entries_per_year: 120,
      avg_entry_cents: toCents(150), subscriber: true,
    });
    assert.ok(
      subbed.contestant_cost_cents < paying.contestant_cost_cents,
      'the subscription must be the cheaper path for the people who use it most',
    );
  });

  it('converting a heavy user to a subscriber is a real revenue trade', () => {
    // Not hidden: we earn less per heavy user, and we earn it predictably.
    const paying = modelContestant({
      label: 'pro', entries_per_year: 120,
      avg_entry_cents: toCents(150), subscriber: false,
    });
    const subbed = modelContestant({
      label: 'pro subbed', entries_per_year: 120,
      avg_entry_cents: toCents(150), subscriber: true,
    });
    assert.ok(subbed.total_cents < paying.total_cents);
    assert.equal(subbed.transaction_net_cents, 0);
    assert.ok(subbed.subscription_cents > 0, 'and all of it recurs');
  });

  it('is deterministic', () => {
    const p = {
      label: 'x', entries_per_year: 40,
      avg_entry_cents: toCents(100), subscriber: false,
    };
    assert.deepEqual(modelContestant(p), modelContestant(p));
  });
});

describe('producer plans', () => {
  it('the ladder actually has rungs', () => {
    // Regression: Starter was unlimited, so recommendPlan could never return
    // Pro or Association and the top of the market went unpriced.
    assert.equal(recommendPlan(60).code, 'grassroots');
    assert.equal(recommendPlan(1_200).code, 'starter');
    assert.equal(recommendPlan(2_400).code, 'pro');
    assert.equal(recommendPlan(50_000).code, 'association');
  });

  it('every plan above the free one is reachable', () => {
    const reachable = new Set(
      [60, 500, 1_200, 3_000, 9_000, 25_000, 100_000].map(
        (n) => recommendPlan(n).code,
      ),
    );
    for (const plan of PRODUCER_PLANS) {
      assert.ok(reachable.has(plan.code), `${plan.code} is unreachable`);
    }
  });

  it('exactly one plan is free, and it is the smallest', () => {
    const free = PRODUCER_PLANS.filter((p) => p.monthly_cents === 0);
    assert.equal(free.length, 1);
    assert.equal(free[0].code, 'grassroots');
    assert.ok(free[0].entry_limit !== null, 'the free tier must be capped');
  });

  it('annual is cheaper than twelve months', () => {
    for (const p of PRODUCER_PLANS) {
      if (p.monthly_cents === 0) continue;
      assert.ok(
        p.annual_cents < p.monthly_cents * 12,
        `${p.code} annual is not a discount`,
      );
    }
  });

  it('each rung includes everything the one below it does', () => {
    for (let i = 1; i < PRODUCER_PLANS.length; i++) {
      const lower = new Set(PRODUCER_PLANS[i - 1].modules);
      for (const m of lower) {
        assert.ok(
          PRODUCER_PLANS[i].modules.includes(m),
          `${PRODUCER_PLANS[i].code} drops '${m}' that ${PRODUCER_PLANS[i - 1].code} has`,
        );
      }
    }
  });

  it('pass-through takes nothing on the money flow', () => {
    const r = calculatePlatformFee({
      entry_total_cents: toCents(100),
      subscriber: false,
      config: PASS_THROUGH_FEES,
    });
    assert.equal(r.platform_fee_cents, 0);
    assert.equal(r.platform_net_cents, 0);
    // The contestant pays the entry plus what the card actually costs.
    assert.equal(r.contestant_pays_cents, toCents(100) + r.processing_fee_cents);
  });

  it('pass-through is the cheapest entry in the sport', () => {
    const rows = compareAllIn(toCents(100), false, PASS_THROUGH_FEES);
    const ours = rows.find((r) => r.name === 'RodeoApps')!;
    for (const other of rows.filter((r) => r.name !== 'RodeoApps')) {
      assert.ok(
        ours.contestant_pays_cents < other.contestant_pays_cents,
        `${other.name} is cheaper than pass-through`,
      );
    }
  });

  it('the flat plan is cheaper for the producer than a 2% cut, at every size', () => {
    // This is the sales argument, and it has to be true rather than asserted.
    for (const [entries, avg] of [
      [200, 50], [1_200, 50], [300, 100], [2_400, 125], [10_000, 150],
    ] as [number, number][]) {
      const c = compareModels(entries, toCents(avg));
      assert.ok(
        c.producer_saves_cents > 0,
        `at ${entries} entries of $${avg} the flat plan costs more`,
      );
    }
  });

  it('a cash-only jackpot still pays us, which a percentage model does not', () => {
    // A percentage of card volume earns zero from a rodeo run out of a cash
    // box. The subscription is independent of how the money moved.
    const plan = recommendPlan(1_200);
    assert.ok(plan.annual_cents > 0);
    const pct = calculatePlatformFee({
      entry_total_cents: 0, // nothing crossed a card
      subscriber: false,
    });
    assert.equal(pct.platform_net_cents, 0);
  });
});
