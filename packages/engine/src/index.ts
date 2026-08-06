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
  validatePayoutRule,
} from './payouts/engine.ts';
export type {
  DayMoneyInput,
  DayMoneyResult,
  MultiRoundInput,
} from './payouts/engine.ts';

export {
  WITHHOLDING_RULES,
  applyWithholding,
  determineApplicableRule,
} from './payouts/withholding.ts';
export type { WithholdingContext } from './payouts/withholding.ts';
