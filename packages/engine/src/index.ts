/**
 * @rodeo-os/engine
 *
 * The scoring and payout engines from §5 and §6 of the RodeoApps.pro OS
 * architecture, plus the cent-exact money arithmetic they depend on.
 *
 * The package has no runtime dependencies and touches no I/O: it is pure
 * calculation over data loaded from `scoring_configs` and `payout_configs`.
 * That is deliberate — these are the two places in the system where a bug
 * costs somebody real money, so they are testable in isolation and the same
 * code runs on the server, in the secretary's browser, and offline.
 */

export * from './types/index.ts';

export {
  allocate,
  assertReconciles,
  formatCents,
  fromCents,
  pctOfCents,
  splitEvenly,
  toCents,
} from './money.ts';

export { calculateJudgedScore } from './scoring/judged.ts';
export { calculateTimedScore } from './scoring/timed.ts';
export { rankResults, tieGroups } from './scoring/rank.ts';
export {
  aggregatesToRankable,
  assignDDivisions,
  calculateAggregate,
} from './scoring/aggregate.ts';
export type { DAssignment, RoundScore } from './scoring/aggregate.ts';
export {
  checkDivisionEligibility,
  eligibleDivisions,
} from './scoring/divisions.ts';
export type {
  DivisionConfig,
  DivisionRule,
  EligibilityResult,
  TeamNumbers,
} from './scoring/divisions.ts';

export {
  calculateDayMoney,
  calculateFees,
  calculateIPRAThreeHead,
  calculateMultiRoundPayout,
  calculatePESIBonus,
  calculatePayout,
  calculateStockContractorPay,
  findPayoutRule,
  payOnePurse,
  payTeamPurse,
  validatePayoutRule,
} from './payouts/engine.ts';
export type {
  DayMoneyInput,
  DayMoneyResult,
  MultiRoundInput,
} from './payouts/engine.ts';

export {
  COMPETITORS,
  DEFAULT_PLATFORM_FEES,
  RODEOAPPS_SUBSCRIPTION,
  STRIPE_STANDARD,
  calculatePlatformFee,
  compareAllIn,
  modelContestant,
  subscriptionBreakEven,
} from './pricing/engine.ts';
export type {
  AnnualRevenue,
  CompetitorRate,
  ContestantProfile,
  PlatformFeeConfig,
  PlatformFeeInput,
  PlatformFeeResult,
  ProcessorRates,
  SubscriptionPricing,
} from './pricing/engine.ts';

export { computeResults, expandTeamResults } from './results/engine.ts';
export type {
  ComputeResultsInput,
  ComputeResultsOutput,
  ComputedResult,
  PointsConfig,
  ResultType,
  ScoreRow,
} from './results/engine.ts';

export {
  checkEntryEligibility,
  classifyTurnout,
  quoteEntryFees,
} from './entries/fees.ts';
export type {
  EntryEligibility,
  EntryEligibilityInput,
  EntryFeeInput,
  EntryFeeQuote,
  FeeLine,
  TurnoutInput,
  TurnoutResult,
} from './entries/fees.ts';

export {
  generateDraw,
  generateStockDraw,
  makeRng,
  redrawStock,
  shuffle,
} from './draw/engine.ts';
export type {
  DrawAssignment,
  DrawEntry,
  DrawMethod,
  DrawRequest,
  DrawResult,
  DrawableAnimal,
  PerformanceSlot,
  StockAssignment,
  StockDrawRequest,
  StockDrawResult,
} from './draw/engine.ts';

export {
  WITHHOLDING_RULES,
  applyWithholding,
  determineApplicableRule,
} from './payouts/withholding.ts';
export type { WithholdingContext } from './payouts/withholding.ts';
