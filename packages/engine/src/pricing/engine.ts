/**
 * Platform pricing.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS IN THE ENGINE AND NOT A SPREADSHEET
 * ---------------------------------------------------------------------------
 * The platform fee is money a contestant pays. It appears on the entry
 * confirmation, it has to reconcile against the ledger, and it has to be
 * identical every time it is quoted. That makes it the same class of thing as
 * a payout split, not a marketing number — so it lives next to the payout
 * engine, in integer cents, with tests.
 *
 * It also means the business model is executable. Changing the take rate is a
 * config change with a test suite behind it, and the revenue model in
 * docs/PRICING.md is computed by the same code that charges the fee.
 * ---------------------------------------------------------------------------
 */

import type { ValidationIssue } from '../types/index.ts';

export interface ProcessorRates {
  /** Stripe standard is 2.9% + 30c. */
  percent: number;
  fixed_cents: number;
}

export const STRIPE_STANDARD: ProcessorRates = {
  percent: 0.029,
  fixed_cents: 30,
};

export interface PlatformFeeConfig {
  /** Rate charged to a contestant with no subscription. */
  standard_percent: number;
  standard_fixed_cents: number;
  /** Rate charged to a RodeoApps subscriber. */
  subscriber_percent: number;
  subscriber_fixed_cents: number;
  /**
   * Cap so a big entry does not carry an absurd fee. A $1,000 NFR-scale entry
   * should not pay $55 to move money.
   */
  cap_cents?: number;
  /** Who the card processing cost falls on. */
  card_fees: 'contestant' | 'producer';
  processor?: ProcessorRates;
}

/**
 * The recommended default.
 *
 * 2.0% and nothing fixed, capped at $15. Subscribers pay zero.
 *
 * The rate has to be set against what a contestant pays ALL-IN, not against a
 * competitor's headline number, because the two are not the same thing.
 * RodeoReady quotes 5.5% + $0.35 and pays card processing OUT of it, so their
 * all-in on a $100 entry is $5.85. Rodeo Producer quotes 1% and puts card fees
 * on top, so theirs is about $4.23.
 *
 * A first draft of this file used 4.9% + $0.30 on the reasoning that it
 * "undercuts 5.5%". Modelled properly it comes to $8.55 all-in — half again
 * more expensive than the competitor it was supposed to beat. Comparing
 * headline rates across platforms that treat processing differently is how
 * that mistake gets made, and it is why compareAllIn() exists.
 *
 * At 2.0% the all-in is $5.26, under RodeoReady and near the price leader.
 * A subscriber pays $3.20 — card processing only, the cheapest entry in the
 * sport. That gap is the product.
 */
export const DEFAULT_PLATFORM_FEES: PlatformFeeConfig = {
  standard_percent: 0.02,
  standard_fixed_cents: 0,
  subscriber_percent: 0,
  subscriber_fixed_cents: 0,
  cap_cents: 1500,
  card_fees: 'contestant',
  processor: STRIPE_STANDARD,
};

export interface PlatformFeeInput {
  /** Entry fees, stock charges, sidepots — everything being charged. */
  entry_total_cents: number;
  /** Whether this contestant holds a RodeoApps subscription. */
  subscriber: boolean;
  config?: PlatformFeeConfig;
}

export interface PlatformFeeResult {
  /** What the platform keeps. */
  platform_fee_cents: number;
  /** What the card processor takes. Never ours. */
  processing_fee_cents: number;
  /** Total the contestant is charged. */
  contestant_pays_cents: number;
  /** What the producer receives. */
  producer_receives_cents: number;
  /** Platform revenue after the processor is paid. */
  platform_net_cents: number;
  /** What a non-subscriber would have paid, for the "you saved" line. */
  saved_vs_standard_cents: number;
  issues: ValidationIssue[];
}

/**
 * Work out the fee on one entry.
 *
 * The processing fee is calculated on the amount actually charged to the card,
 * which includes the platform fee — the processor takes its cut of everything
 * that moves, and a model that forgets this understates cost on every
 * transaction.
 */
export function calculatePlatformFee(
  input: PlatformFeeInput,
): PlatformFeeResult {
  const config = input.config ?? DEFAULT_PLATFORM_FEES;
  const processor = config.processor ?? STRIPE_STANDARD;
  const issues: ValidationIssue[] = [];

  if (input.entry_total_cents < 0) {
    issues.push({
      field: 'entry_total_cents',
      code: 'NEGATIVE_TOTAL',
      severity: 'error',
      message: 'An entry total cannot be negative.',
    });
    return {
      platform_fee_cents: 0,
      processing_fee_cents: 0,
      contestant_pays_cents: 0,
      producer_receives_cents: 0,
      platform_net_cents: 0,
      saved_vs_standard_cents: 0,
      issues,
    };
  }

  const rate = (percent: number, fixed: number): number => {
    if (input.entry_total_cents === 0) return 0;
    const raw = Math.round(input.entry_total_cents * percent) + fixed;
    return config.cap_cents ? Math.min(raw, config.cap_cents) : raw;
  };

  const standardFee = rate(config.standard_percent, config.standard_fixed_cents);
  const platformFee = input.subscriber
    ? rate(config.subscriber_percent, config.subscriber_fixed_cents)
    : standardFee;

  // The processor charges on everything that crosses the card, platform fee
  // included.
  const charged = input.entry_total_cents + platformFee;
  const processing =
    charged === 0
      ? 0
      : Math.round(charged * processor.percent) + processor.fixed_cents;

  const contestantPays =
    config.card_fees === 'contestant' ? charged + processing : charged;
  const producerReceives =
    config.card_fees === 'contestant'
      ? input.entry_total_cents
      : input.entry_total_cents - processing;

  return {
    platform_fee_cents: platformFee,
    processing_fee_cents: processing,
    contestant_pays_cents: contestantPays,
    producer_receives_cents: producerReceives,
    // The processor's cut is never ours, whoever is billed for it.
    platform_net_cents: platformFee,
    saved_vs_standard_cents: standardFee - platformFee,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Revenue modelling
// ---------------------------------------------------------------------------

export interface ContestantProfile {
  label: string;
  /** Paid entries per year. */
  entries_per_year: number;
  /** Average total charged per entry, in cents. */
  avg_entry_cents: number;
  subscriber: boolean;
}

export interface SubscriptionPricing {
  monthly_cents: number;
  annual_cents: number;
  /** Share of subscribers who pay annually rather than monthly. */
  annual_share: number;
}

export const RODEOAPPS_SUBSCRIPTION: SubscriptionPricing = {
  monthly_cents: 499,
  annual_cents: 4999,
  annual_share: 0.6,
};

export interface AnnualRevenue {
  label: string;
  transaction_net_cents: number;
  subscription_cents: number;
  total_cents: number;
  /** What this contestant paid us in fees, for the fairness check. */
  contestant_cost_cents: number;
}

/**
 * Annual revenue from one contestant, and what it costs them.
 *
 * Both numbers matter. A pricing model that only reports revenue will happily
 * recommend gouging the people the platform depends on.
 */
export function modelContestant(
  profile: ContestantProfile,
  subscription: SubscriptionPricing = RODEOAPPS_SUBSCRIPTION,
  config: PlatformFeeConfig = DEFAULT_PLATFORM_FEES,
): AnnualRevenue {
  let transactionNet = 0;
  let contestantCost = 0;

  for (let i = 0; i < profile.entries_per_year; i++) {
    const fee = calculatePlatformFee({
      entry_total_cents: profile.avg_entry_cents,
      subscriber: profile.subscriber,
      config,
    });
    transactionNet += fee.platform_net_cents;
    contestantCost += fee.platform_fee_cents;
  }

  const subscriptionRevenue = profile.subscriber
    ? Math.round(
        subscription.annual_cents * subscription.annual_share +
          subscription.monthly_cents * 12 * (1 - subscription.annual_share),
      )
    : 0;

  return {
    label: profile.label,
    transaction_net_cents: transactionNet,
    subscription_cents: subscriptionRevenue,
    total_cents: transactionNet + subscriptionRevenue,
    contestant_cost_cents: contestantCost + subscriptionRevenue,
  };
}

/**
 * The break-even point: how many entries a year before subscribing is cheaper
 * than paying the standard fee.
 *
 * This is the single most important number in the model. Below it, the
 * subscription is a bad deal and a contestant who does the arithmetic will
 * feel misled. Above it, subscribing is obviously correct and the pitch writes
 * itself.
 */
export function subscriptionBreakEven(
  avgEntryCents: number,
  subscription: SubscriptionPricing = RODEOAPPS_SUBSCRIPTION,
  config: PlatformFeeConfig = DEFAULT_PLATFORM_FEES,
): { entries: number; annual_fee_cents: number; per_entry_saving_cents: number } {
  const standard = calculatePlatformFee({
    entry_total_cents: avgEntryCents,
    subscriber: false,
    config,
  });
  const subscribed = calculatePlatformFee({
    entry_total_cents: avgEntryCents,
    subscriber: true,
    config,
  });

  const saving = standard.platform_fee_cents - subscribed.platform_fee_cents;
  if (saving <= 0) {
    return {
      entries: Number.POSITIVE_INFINITY,
      annual_fee_cents: subscription.annual_cents,
      per_entry_saving_cents: 0,
    };
  }

  return {
    entries: Math.ceil(subscription.annual_cents / saving),
    annual_fee_cents: subscription.annual_cents,
    per_entry_saving_cents: saving,
  };
}

/** A competitor's rate, for side-by-side comparison. */
export interface CompetitorRate {
  name: string;
  percent: number;
  fixed_cents: number;
  /** True when their quoted rate already includes card processing. */
  includes_processing: boolean;
}

export const COMPETITORS: CompetitorRate[] = [
  // Published: 5.5% + $0.35, paid by the competitor, out of which they cover
  // card charges of roughly 3%.
  { name: 'RodeoReady', percent: 0.055, fixed_cents: 35, includes_processing: true },
  // Published: 1% administration fee on transactions, card fees on top.
  { name: 'Rodeo Producer', percent: 0.01, fixed_cents: 0, includes_processing: false },
];

/** What a contestant pays per entry on each platform, all-in. */
export function compareAllIn(
  entryTotalCents: number,
  subscriber: boolean,
  config: PlatformFeeConfig = DEFAULT_PLATFORM_FEES,
): { name: string; contestant_pays_cents: number }[] {
  const processor = config.processor ?? STRIPE_STANDARD;
  const ours = calculatePlatformFee({
    entry_total_cents: entryTotalCents,
    subscriber,
    config,
  });

  const rows = [
    {
      name: subscriber ? 'RodeoApps (subscriber)' : 'RodeoApps',
      contestant_pays_cents: ours.contestant_pays_cents,
    },
  ];

  for (const c of COMPETITORS) {
    const fee = Math.round(entryTotalCents * c.percent) + c.fixed_cents;
    const processing = c.includes_processing
      ? 0
      : Math.round((entryTotalCents + fee) * processor.percent) +
        processor.fixed_cents;
    rows.push({
      name: c.name,
      contestant_pays_cents: entryTotalCents + fee + processing,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Flat producer subscription — the recommended model
// ---------------------------------------------------------------------------

/**
 * A producer plan.
 *
 * The alternative to taking a percentage of entries, and the one this platform
 * should sell. The reasoning is in docs/PRICING.md; the short version is that
 * a flat price is one sentence to sell, it captures cash rodeos that a
 * percentage model earns nothing from, and charging zero on the money flow
 * makes this the cheapest place in the country to enter a rodeo — which is a
 * producer's argument to their own field, not just ours to them.
 */
export interface ProducerPlan {
  code: string;
  label: string;
  monthly_cents: number;
  annual_cents: number;
  /** Entries a year included. Null = unlimited. */
  entry_limit: number | null;
  /** Module codes this plan turns on, from reference_options domain 'module'. */
  modules: string[];
}

/**
 * The ladder.
 *
 * A free bottom rung is not generosity, it is defence: Rodeo Producer is
 * effectively free for a producer who takes online payments, so a $29.99 floor
 * would hand them every weekly roping in the country. Free below 100 entries a
 * year costs almost nothing to serve and keeps the grassroots on the platform,
 * where their contestants join the apps.
 *
 * The upper rungs exist because a flat price with no ladder charges an
 * association pushing 10,000 entries the same as somebody running two jackpots
 * a year. That is not simplicity, it is leaving the top of the market unpriced.
 */
export const PRODUCER_PLANS: ProducerPlan[] = [
  {
    code: 'grassroots',
    label: 'Grassroots',
    monthly_cents: 0,
    annual_cents: 0,
    entry_limit: 100,
    modules: ['events', 'entries', 'contestants', 'results', 'waivers'],
  },
  {
    // The rung that stops a flat model punishing the grassroots. A weekly
    // roping doing 200 entries a year at $25-50 a head is over the free cap
    // but nowhere near worth $29.99 a month — modelled against a 2% cut it
    // would be paying MORE for the flat plan, which is the one outcome that
    // makes the whole pitch collapse. $9.99 keeps it honest at every size.
    code: 'club',
    label: 'Club',
    monthly_cents: 999,
    annual_cents: 9990,
    entry_limit: 500,
    modules: [
      'events', 'entries', 'contestants', 'results', 'waivers',
      'scoring', 'payouts',
    ],
  },
  {
    code: 'starter',
    label: 'Starter',
    monthly_cents: 2999,
    annual_cents: 29990, // two months free on annual
    // Capped, or the ladder has no rungs above it: if Starter were unlimited
    // an association pushing 10,000 entries would sit on it forever and the
    // top of the market would go unpriced. 1,500 covers a weekly roping and a
    // committee running a handful of rodeos a year, which is who it is for.
    entry_limit: 1_500,
    modules: [
      'events', 'entries', 'contestants', 'results', 'waivers',
      'scoring', 'payouts', 'sidepots',
    ],
  },
  {
    code: 'pro',
    label: 'Pro',
    monthly_cents: 9900,
    annual_cents: 99000,
    entry_limit: 10_000,
    modules: [
      'events', 'entries', 'contestants', 'results', 'waivers',
      'scoring', 'payouts', 'sidepots', 'handicap',
      'timer', 'broadcast', 'stock', 'analytics',
    ],
  },
  {
    code: 'association',
    label: 'Association',
    monthly_cents: 29900,
    annual_cents: 299000,
    entry_limit: null,
    modules: [
      'events', 'entries', 'contestants', 'results', 'waivers',
      'scoring', 'payouts', 'sidepots', 'handicap',
      'timer', 'broadcast', 'stock', 'analytics', 'series', 'tax',
    ],
  },
];

/**
 * Pass-through processing: the platform takes nothing on the money flow.
 *
 * This is the configuration that goes with a flat subscription. The contestant
 * pays the entry plus what the card actually costs, and not one cent more.
 */
export const PASS_THROUGH_FEES: PlatformFeeConfig = {
  standard_percent: 0,
  standard_fixed_cents: 0,
  subscriber_percent: 0,
  subscriber_fixed_cents: 0,
  card_fees: 'contestant',
  processor: STRIPE_STANDARD,
};

export function planFor(code: string): ProducerPlan | null {
  return PRODUCER_PLANS.find((p) => p.code === code) ?? null;
}

/**
 * Cheapest plan that covers an expected annual entry count.
 *
 * A producer who needs a specific module (timer integration, say) may sit
 * above this — the entry count is the floor, not the ceiling.
 */
export function recommendPlan(entriesPerYear: number): ProducerPlan {
  const fits = PRODUCER_PLANS.filter(
    (p) => p.entry_limit === null || entriesPerYear <= p.entry_limit,
  );
  if (fits.length === 0) {
    // Above every cap: the unlimited plan, which is the last rung by design.
    return PRODUCER_PLANS[PRODUCER_PLANS.length - 1];
  }
  return fits.reduce((cheapest, p) =>
    p.monthly_cents < cheapest.monthly_cents ? p : cheapest,
  );
}

export interface ModelComparison {
  entries_per_year: number;
  /** What a percentage model would take from this producer. */
  percentage_model_cents: number;
  /** What the flat plan costs them. */
  flat_model_cents: number;
  plan: string;
  /** Positive when the flat plan is cheaper for the producer. */
  producer_saves_cents: number;
}

/**
 * Compare the two models for one producer.
 *
 * Reported from the PRODUCER's side deliberately. A pricing decision made only
 * on which model bills more is how a platform prices itself out of the market
 * it is trying to enter.
 */
export function compareModels(
  entriesPerYear: number,
  avgEntryCents: number,
  percentageConfig: PlatformFeeConfig = DEFAULT_PLATFORM_FEES,
): ModelComparison {
  const perEntry = calculatePlatformFee({
    entry_total_cents: avgEntryCents,
    subscriber: false,
    config: percentageConfig,
  }).platform_net_cents;

  const plan = recommendPlan(entriesPerYear);
  const flat = plan.annual_cents;
  const pct = perEntry * entriesPerYear;

  return {
    entries_per_year: entriesPerYear,
    percentage_model_cents: pct,
    flat_model_cents: flat,
    plan: plan.code,
    producer_saves_cents: pct - flat,
  };
}
