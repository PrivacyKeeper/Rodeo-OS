/**
 * Shared types for the scoring and payout engines.
 *
 * Architecture ref: §5.2 (scoring config schema), §6.2 (payout input).
 *
 * Money is INTEGER CENTS everywhere in this package. Rodeo purses are split
 * by percentage and then again among tied contestants; doing that in floating
 * point loses cents, and §7.4 sets "sum of payouts = net purse" as a metric
 * with a target of zero errors. Cents in, cents out, and the allocation is
 * done by largest remainder so the total is exact by construction.
 */

export type ScoringMode = 'judged' | 'timed';

export type ScoreStatus =
  | 'provisional'
  | 'official'
  | 'dq'
  | 'no_time'
  | 'reride'
  | 'medical_out'
  | 'turned_out'
  | 'scratched';

export type TieResolution = 'combine_and_split' | 'runoff' | 'both_advance';

export type ScoreSource =
  | 'manual'
  | 'timer_hardware'
  | 'web_serial'
  | 'import'
  | 'timer_bridge';

// ---------------------------------------------------------------------------
// Scoring configuration (row `scoring_configs.config`)
// ---------------------------------------------------------------------------

export interface ScoringComponent {
  /** 'rider' | 'animal' | 'rein_work' | 'cow_work' | ... */
  name: string;
  min: number;
  max: number;
  /** How many judges score this component. */
  judges: number;
}

export interface TimedPenaltyRule {
  /** 'barrier_break' | 'one_leg_catch' | 'barrel_knockdown' | ... */
  type: string;
  seconds: number;
  /**
   * When true the penalty may be applied more than once in a run and the
   * caller supplies a count (barrel knockdowns). Defaults to false.
   */
  repeatable?: boolean;
}

export interface ScoringConfig {
  id?: string;
  sanctioning_body?: string | null;
  event_type?: string | null;
  season?: string | null;
  effective_date?: string | null;

  mode: ScoringMode;

  // ---- judged ----
  max_score?: number;
  components?: ScoringComponent[];
  /** 0.5 (PRCA), 0.1 (PBR 2026). Absent means any value is accepted. */
  increment?: number;
  /** Rider total may not exceed animal total by more than this. */
  variance_cap?: number;
  /**
   * Whether breaching variance_cap is a warning or a hard failure.
   * §5.7 says "warning flag, not hard rejection", but the reference code in
   * §5.3 returns valid:false. Defaults to advisory, matching §5.7.
   * See docs/SPEC-DELTAS.md D11.
   */
  variance_cap_is_advisory?: boolean;
  ride_duration_seconds?: number;
  mark_out_required?: boolean;

  // ---- timed ----
  /** Decimal places kept on a final time. 1 = tenths, 3 = thousandths. */
  time_precision?: number;
  timed_penalties?: TimedPenaltyRule[];
  /** Tie-down / goat tying: rope or tie must hold this long. */
  tie_must_hold_seconds?: number;

  // ---- qualification ----
  /** NHSRA reined cow horse: must exceed this to place at all. */
  min_score_to_place?: number;

  dq_triggers?: string[];
  reride_conditions?: string[];
  tie_resolution?: TieResolution;

  /** Marks a template whose source rulebook has not been obtained. */
  unverified?: boolean;
  unverified_note?: string;
}

// ---------------------------------------------------------------------------
// Scoring inputs and outputs
// ---------------------------------------------------------------------------

export interface JudgeScoreInput {
  judge_id: string;
  judge_position: number;
  components: { name: string; value: number }[];
}

export interface JudgedRunInput {
  judges: JudgeScoreInput[];
  /** Bareback and saddle bronc: did the rider mark the horse out? */
  marked_out?: boolean;
  /** Config-driven trigger names that fired during the ride. */
  dq_triggers?: string[];
}

export interface TimedRunInput {
  /** null means the run produced no time (missed catch, off pattern). */
  raw_time: number | null;
  penalties?: { type: string; count?: number }[];
  /** Barrel racing convenience: equivalent to a repeatable knockdown penalty. */
  barrels_knocked?: number;
  /** Tie-down / goat tying: seconds the tie actually held. */
  tie_held_seconds?: number;
  source?: ScoreSource;
  dq_triggers?: string[];
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
  code: string;
}

export interface JudgedScoreResult {
  kind: 'judged';
  valid: boolean;
  status: ScoreStatus;
  issues: ValidationIssue[];
  final_score: number | null;
  rider_score: number | null;
  animal_score: number | null;
  judge_scores: JudgeScoreInput[];
  dq_reason?: string;
}

export interface TimedScoreResult {
  kind: 'timed';
  valid: boolean;
  status: ScoreStatus;
  issues: ValidationIssue[];
  raw_time: number | null;
  penalty_seconds: number;
  penalties_applied: { type: string; seconds: number }[];
  final_time: number | null;
  dq_reason?: string;
}

export type ScoreResult = JudgedScoreResult | TimedScoreResult;

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** The minimum a record needs for the ranker to place it. */
export interface Rankable {
  contestant_id: string;
  status: ScoreStatus;
  final_score?: number | null;
  final_time?: number | null;
}

export interface RankedResult<T extends Rankable = Rankable> {
  entry: T;
  contestant_id: string;
  /** Standard competition ranking: 1, 2, 2, 4. */
  place: number;
  is_tied: boolean;
  tied_with: string[];
  /** The value that was ranked on, for display and audit. */
  ranked_value: number;
}

export interface AggregateResult {
  contestant_id: string;
  aggregate_value: number;
  rounds_counted: number;
  complete: boolean;
}

export interface DFormatConfig {
  divisions: number;
  /** Offsets from the fastest time that open each division, ascending. */
  time_splits: number[];
  /** Share of the purse each division receives, same length as divisions. */
  division_pcts: number[];
}

// ---------------------------------------------------------------------------
// Payout configuration (row `payout_configs.config`)
// ---------------------------------------------------------------------------

export interface FeeStructure {
  /** Fraction of the gross purse, e.g. 0.06. */
  admin_pct?: number;
  /** Flat amounts charged PER ENTRY, in cents. */
  office_fee_flat?: number;
  facility_fee_flat?: number;
  cres_fee?: number;
  sports_medicine_fee?: number;
  circuit_fee?: number;
  insurance_fee?: number;
}

export interface PayoutRule {
  min_entries: number;
  max_entries: number;
  places_paid: number;
  /** Must have exactly places_paid entries and sum to 1. */
  splits: number[];
}

export interface PayoutConfig {
  id?: string;
  sanctioning_body?: string | null;
  season?: string | null;

  fee_structure?: FeeStructure;
  payout_rules: PayoutRule[];

  go_round_average_split?: { go_round_pct: number; average_pct: number };

  /** 'combine_and_split' spreads unfilled places over those who qualified. */
  ground_money_rule?: 'combine_and_split' | 'none';
  /** "Cowboy rules": unfilled places are simply not paid out. */
  no_ground_money?: boolean;

  escrow_on_no_qualified?: boolean;
  day_money_enabled?: boolean;
  /** Fraction of contestant payout owed to stock contractors, e.g. 0.30. */
  stock_contractor_pct?: number;

  is_d_format?: boolean;
  d_format?: DFormatConfig;

  tie_resolution?: TieResolution;

  unverified?: boolean;
  unverified_note?: string;
}

// ---------------------------------------------------------------------------
// Payout inputs and outputs
// ---------------------------------------------------------------------------

export type PayoutLineType =
  | 'prize'
  | 'go_round'
  | 'average'
  | 'd_division'
  | 'day_money'
  | 'stock_contractor'
  | 'pesi_offspring'
  | 'pesi_stallion';

export interface PayoutLine {
  contestant_id: string | null;
  type: PayoutLineType;
  place?: number;
  go_round?: number;
  d_division?: number;
  /** Total owed, in cents. Always prize_cents + ground_money_cents. */
  amount_cents: number;
  prize_cents: number;
  ground_money_cents: number;
  tied_with?: string[];
  description?: string;
}

export interface FeeBreakdown {
  admin_fee_cents: number;
  office_fee_cents: number;
  facility_fee_cents: number;
  cres_fee_cents: number;
  sports_medicine_fee_cents: number;
  circuit_fee_cents: number;
  insurance_fee_cents: number;
  total_cents: number;
  destinations: { type: string; amount_cents: number; destination: string }[];
}

export interface PayoutResult {
  ok: boolean;
  issues: ValidationIssue[];
  gross_purse_cents: number;
  fees: FeeBreakdown;
  net_purse_cents: number;
  /** Cents held back because nobody qualified (CPRA escrow). */
  escrow_cents: number;
  /** Cents not paid out at all ("cowboy rules" unfilled places). */
  unpaid_cents: number;
  payouts: PayoutLine[];
}

export interface Entryish {
  contestant_id: string;
  status: string;
  /** Overrides the event entry fee for this entry, in cents. */
  entry_fee_cents?: number;
}

export interface PayoutCalculationInput {
  payout_config: PayoutConfig;
  scoring_mode: ScoringMode;
  results: Rankable[];
  entries: Entryish[];
  /** Cents. */
  added_money_cents: number;
  entry_fee_cents: number;
}

// ---------------------------------------------------------------------------
// Tax withholding (§6.6)
// ---------------------------------------------------------------------------

export interface WithholdingRule {
  code: 'reg_105' | 'payg_no_abn' | 'irrf';
  name: string;
  rate: number;
  rate_tax_haven?: number;
  form: string;
  exemptions: string[];
  /** Always shown in the UI. This engine does not give tax advice. */
  advisory: string;
}

export interface WithholdingResult {
  gross_cents: number;
  withholding_cents: number;
  net_cents: number;
  rate: number;
  rule?: WithholdingRule;
  exemption_applied?: string;
  advisory: string | null;
}
