/**
 * Payout engine.
 *
 * Architecture ref: §6.1–6.4.
 *
 * Deterministic and idempotent: the same inputs always produce byte-identical
 * output, which is what allows a payout run to be repeated safely after a
 * failed disbursement (§6.1). Nothing here reads the clock or a random source.
 *
 * All money is integer cents. See ../money.ts for why.
 */

import {
  allocate,
  assertReconciles,
  pctOfCents,
  splitEvenly,
} from '../money.ts';
import { assignDDivisions } from '../scoring/aggregate.ts';
import { rankResults, tieGroups } from '../scoring/rank.ts';
import type {
  DFormatConfig,
  Entryish,
  FeeBreakdown,
  PayoutCalculationInput,
  PayoutConfig,
  PayoutLine,
  PayoutResult,
  PayoutRule,
  Rankable,
  RankedResult,
  ScoringConfig,
  ScoringMode,
  ValidationIssue,
} from '../types/index.ts';

const COUNTS_AS_ENTERED = new Set(['confirmed', 'drawn']);

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

export function calculateFees(
  grossPurseCents: number,
  numEntries: number,
  config: PayoutConfig,
): FeeBreakdown {
  const f = config.fee_structure ?? {};
  const perEntry = (flat: number | undefined) => (flat ?? 0) * numEntries;

  const admin = pctOfCents(grossPurseCents, f.admin_pct ?? 0);
  const office = perEntry(f.office_fee_flat);
  const facility = perEntry(f.facility_fee_flat);
  const cres = perEntry(f.cres_fee);
  const sportsMed = perEntry(f.sports_medicine_fee);
  const circuit = perEntry(f.circuit_fee);
  const insurance = perEntry(f.insurance_fee);

  const total =
    admin + office + facility + cres + sportsMed + circuit + insurance;

  return {
    admin_fee_cents: admin,
    office_fee_cents: office,
    facility_fee_cents: facility,
    cres_fee_cents: cres,
    sports_medicine_fee_cents: sportsMed,
    circuit_fee_cents: circuit,
    insurance_fee_cents: insurance,
    total_cents: total,
    destinations: [
      { type: 'admin', amount_cents: admin, destination: 'producer' },
      { type: 'office', amount_cents: office, destination: 'producer' },
      { type: 'facility', amount_cents: facility, destination: 'venue' },
      { type: 'cres', amount_cents: cres, destination: 'cpra_central' },
      {
        type: 'sports_medicine',
        amount_cents: sportsMed,
        destination: 'association',
      },
      { type: 'circuit', amount_cents: circuit, destination: 'circuit_association' },
      { type: 'insurance', amount_cents: insurance, destination: 'insurer' },
    ].filter((d) => d.amount_cents > 0),
  };
}

export function findPayoutRule(
  numEntries: number,
  config: PayoutConfig,
): PayoutRule | null {
  return (
    config.payout_rules.find(
      (r) => numEntries >= r.min_entries && numEntries <= r.max_entries,
    ) ?? null
  );
}

/**
 * A rule whose splits do not line up with places_paid, or do not sum to 1,
 * silently loses or invents money. The architecture never validates either.
 */
export function validatePayoutRule(rule: PayoutRule): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (rule.splits.length !== rule.places_paid) {
    issues.push({
      field: 'payout_rule.splits',
      code: 'SPLITS_LENGTH_MISMATCH',
      severity: 'error',
      message:
        `Rule pays ${rule.places_paid} places but defines ` +
        `${rule.splits.length} splits.`,
    });
  }

  const sum = rule.splits.reduce((s, v) => s + v, 0);
  if (Math.abs(sum - 1) > 0.0001) {
    issues.push({
      field: 'payout_rule.splits',
      code: 'SPLITS_DO_NOT_SUM',
      severity: 'error',
      message: `Splits sum to ${sum.toFixed(4)}, expected 1.0.`,
    });
  }

  if (rule.splits.some((s) => s < 0)) {
    issues.push({
      field: 'payout_rule.splits',
      code: 'NEGATIVE_SPLIT',
      severity: 'error',
      message: 'A split is negative.',
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Standard single-round payout
// ---------------------------------------------------------------------------

function emptyLine(
  contestantId: string,
  type: PayoutLine['type'],
): PayoutLine {
  return {
    contestant_id: contestantId,
    type,
    amount_cents: 0,
    prize_cents: 0,
    ground_money_cents: 0,
  };
}

/**
 * Pay one purse against one ranked field.
 *
 * Handles, in order: nobody qualified; fewer qualified than places paid
 * (ground money, or "cowboy rules" where the unfilled places are simply not
 * paid); and ties, where the money for the places a tie group occupies is
 * combined and divided equally among them.
 *
 * The whole purse is allocated in one pass with largest-remainder rounding, so
 * the returned lines sum to exactly `netPurseCents` (minus anything reported
 * as unpaid or escrowed). That is asserted before returning.
 */
export function payOnePurse(
  netPurseCents: number,
  ranked: RankedResult[],
  rule: PayoutRule,
  config: PayoutConfig,
  lineType: PayoutLine['type'] = 'prize',
): { lines: PayoutLine[]; unpaidCents: number } {
  if (netPurseCents <= 0 || ranked.length === 0) {
    return { lines: [], unpaidCents: Math.max(0, netPurseCents) };
  }

  const groups = tieGroups(ranked);

  // Weight per place, from the rule. Places beyond places_paid weigh nothing.
  const weightForPlace = (place: number): number =>
    place >= 1 && place <= rule.places_paid ? rule.splits[place - 1] : 0;

  // ---- Which places actually have somebody standing in them? --------------
  // A tie group starting at place P and containing N contestants occupies
  // places P .. P+N-1. Their combined weight is the sum of those splits.
  const groupWeights = groups.map((group) => {
    const start = group[0].place;
    let weight = 0;
    for (let k = 0; k < group.length; k++) weight += weightForPlace(start + k);
    return weight;
  });

  const claimedWeight = groupWeights.reduce((s, w) => s + w, 0);
  const unclaimedWeight = Math.max(0, 1 - claimedWeight);

  const lines: PayoutLine[] = [];

  // ---- Nothing claimed at all ---------------------------------------------
  if (claimedWeight <= 0) {
    return { lines: [], unpaidCents: netPurseCents };
  }

  // ---- Money for the unfilled places --------------------------------------
  // "Cowboy rules": it is not paid. Otherwise it is ground money, spread
  // equally over everyone who qualified — not over the paid places only.
  const payGroundMoney =
    unclaimedWeight > 0 &&
    !config.no_ground_money &&
    config.ground_money_rule !== 'none';

  const prizePoolCents = pctOfCents(netPurseCents, claimedWeight);
  const groundPoolCents = payGroundMoney ? netPurseCents - prizePoolCents : 0;
  const unpaidCents = payGroundMoney ? 0 : netPurseCents - prizePoolCents;

  // ---- Allocate the prize pool across tie groups --------------------------
  const groupCents = allocate(prizePoolCents, groupWeights);
  assertReconciles(groupCents, prizePoolCents, 'prize pool');

  const allContestants: string[] = [];

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const shares = splitEvenly(groupCents[g], group.length);

    for (let k = 0; k < group.length; k++) {
      const member = group[k];
      allContestants.push(member.contestant_id);
      const line = emptyLine(member.contestant_id, lineType);
      line.place = member.place;
      line.prize_cents = shares[k];
      line.amount_cents = shares[k];
      if (member.is_tied) line.tied_with = member.tied_with;
      lines.push(line);
    }
  }

  // ---- Ground money -------------------------------------------------------
  if (groundPoolCents > 0 && lines.length > 0) {
    const groundShares = splitEvenly(groundPoolCents, lines.length);
    assertReconciles(groundShares, groundPoolCents, 'ground money');
    for (let i = 0; i < lines.length; i++) {
      lines[i].ground_money_cents = groundShares[i];
      lines[i].amount_cents += groundShares[i];
    }
  }

  assertReconciles(
    lines.map((l) => l.amount_cents),
    netPurseCents - unpaidCents,
    'purse',
  );

  // Contestants who qualified but placed outside the money get no line at all.
  return { lines: lines.filter((l) => l.amount_cents > 0), unpaidCents };
}

// ---------------------------------------------------------------------------
// Team events
// ---------------------------------------------------------------------------

/**
 * Pay a purse to teams rather than to individuals.
 *
 * TEAM ROPING is the case that forces this to exist, and getting it wrong is
 * a five-figure error at a big rodeo. The rules:
 *
 *   - A team places ONCE. Two ropers, one time on the clock.
 *   - Both ropers paid an entry fee, so the purse was built from two fees per
 *     team, not one.
 *   - Each roper is credited the FULL place amount. PRCA publishes these as
 *     "$X-a-Man", and headers and heelers carry separate world standings —
 *     one partner can make the NFR while the other does not.
 *
 * Paying the whole purse to the team and then handing each roper that same
 * amount would disburse twice the purse. Paying half each would under-credit
 * both against every published result. The correct model, and the one here:
 * split the purse into one equal pool per END, then pay the identical team
 * ranking out of each pool. Header and heeler receive the same amount, that
 * amount is what goes in the standings, and the total disbursed is exactly
 * the purse.
 *
 * Worked check, winner-take-all: 10 teams, every roper pays $50, so the purse
 * is 20 x $50 = $1,000 — twice what the same number of individual entries
 * would raise. Two ends, so $500 per end pool. The winning team takes 100% of
 * each: $500 to the header, $500 to the heeler, $1,000 out the door. An
 * individual event with 10 entries at $50 raises $500 and pays its winner
 * $500. Same money per person for the same field size and fee — which is
 * exactly the equal-money parity the ropers put to the PRCA board.
 *
 * RANCH RODEO teams work the other way: one entry for the team, and the
 * team's money is divided among its members. That is `split_between`.
 */
export function payTeamPurse(
  netPurseCents: number,
  rankedTeams: RankedResult[],
  rule: PayoutRule,
  config: PayoutConfig,
  lineType: PayoutLine['type'] = 'prize',
): { lines: PayoutLine[]; unpaidCents: number; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const mode = config.team_payout ?? 'split_between';

  const memberCounts = rankedTeams.map((r) => r.entry.team_members?.length ?? 0);
  if (memberCounts.some((n) => n === 0)) {
    issues.push({
      field: 'team_members',
      code: 'MISSING_TEAM_MEMBERS',
      severity: 'error',
      message:
        'A team event needs team_members on every result; one or more are ' +
        'missing, and nobody can be paid from a team with no people on it.',
    });
    return { lines: [], unpaidCents: netPurseCents, issues };
  }

  // ---- split_between: pay the team, then divide inside it -----------------
  if (mode === 'split_between') {
    const { lines: teamLines, unpaidCents } = payOnePurse(
      netPurseCents,
      rankedTeams,
      rule,
      config,
      lineType,
    );

    const lines: PayoutLine[] = [];
    for (const teamLine of teamLines) {
      const team = rankedTeams.find(
        (r) => r.contestant_id === teamLine.contestant_id,
      );
      const members = team?.entry.team_members ?? [];
      if (members.length === 0) continue;

      const shares = splitEvenly(teamLine.amount_cents, members.length);
      assertReconciles(shares, teamLine.amount_cents, 'team split');

      members.forEach((memberId, i) => {
        lines.push({
          ...teamLine,
          contestant_id: memberId,
          amount_cents: shares[i],
          prize_cents: shares[i],
          ground_money_cents: 0,
          description: `Team share (${i + 1} of ${members.length})`,
        });
      });
    }

    assertReconciles(
      lines.map((l) => l.amount_cents),
      netPurseCents - unpaidCents,
      'team purse (split_between)',
    );
    return { lines, unpaidCents, issues };
  }

  // ---- full_to_each: one equal pool per end -------------------------------
  const ends = Math.max(...memberCounts);
  if (memberCounts.some((n) => n !== ends)) {
    issues.push({
      field: 'team_members',
      code: 'RAGGED_TEAM_SIZES',
      severity: 'error',
      message:
        `Teams have different member counts (${[...new Set(memberCounts)].join(', ')}). ` +
        'full_to_each splits the purse per end, so every team must have the same ends.',
    });
    return { lines: [], unpaidCents: netPurseCents, issues };
  }

  const endPools = splitEvenly(netPurseCents, ends);
  assertReconciles(endPools, netPurseCents, 'end pools');

  const lines: PayoutLine[] = [];
  let unpaid = 0;

  for (let end = 0; end < ends; end++) {
    const { lines: endLines, unpaidCents } = payOnePurse(
      endPools[end],
      rankedTeams,
      rule,
      config,
      lineType,
    );
    unpaid += unpaidCents;

    for (const line of endLines) {
      const team = rankedTeams.find((r) => r.contestant_id === line.contestant_id);
      const memberId = team?.entry.team_members?.[end];
      if (!memberId) continue;
      lines.push({
        ...line,
        contestant_id: memberId,
        description: `End ${end + 1} of ${ends}`,
      });
    }
  }

  assertReconciles(
    lines.map((l) => l.amount_cents),
    netPurseCents - unpaid,
    'team purse (full_to_each)',
  );

  return { lines, unpaidCents: unpaid, issues };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function calculatePayout(input: PayoutCalculationInput): PayoutResult {
  const issues: ValidationIssue[] = [];
  const config = input.payout_config;

  const counted = input.entries.filter((e) => COUNTS_AS_ENTERED.has(e.status));

  // Every roper pays, but the payout LADDER is selected by how many teams are
  // competing, not how many people. Ten teams is a ten-entry roping even
  // though twenty fees came in the door.
  const isTeamEvent = config.team_payout !== undefined;
  const teamCount = isTeamEvent
    ? new Set(
        input.results
          .filter((r) => r.team_members?.length)
          .map((r) => r.contestant_id),
      ).size
    : 0;
  const numEntries = isTeamEvent && teamCount > 0 ? teamCount : counted.length;

  const entryFeePool = counted.reduce(
    (s, e) => s + (e.entry_fee_cents ?? input.entry_fee_cents),
    0,
  );
  const grossPurse = input.added_money_cents + entryFeePool;

  const fees = calculateFees(grossPurse, numEntries, config);
  const netPurse = grossPurse - fees.total_cents;

  const empty: PayoutResult = {
    ok: false,
    issues,
    gross_purse_cents: grossPurse,
    fees,
    net_purse_cents: netPurse,
    escrow_cents: 0,
    unpaid_cents: 0,
    payouts: [],
  };

  if (netPurse < 0) {
    issues.push({
      field: 'fees',
      code: 'FEES_EXCEED_PURSE',
      severity: 'error',
      message:
        `Fees of ${fees.total_cents} cents exceed the gross purse of ` +
        `${grossPurse} cents. Check the fee structure.`,
    });
    return empty;
  }

  const rule = findPayoutRule(numEntries, config);
  if (!rule) {
    issues.push({
      field: 'payout_rules',
      code: 'NO_MATCHING_RULE',
      severity: 'error',
      message: `No payout rule covers ${numEntries} entries.`,
    });
    return empty;
  }

  const ruleIssues = validatePayoutRule(rule);
  if (ruleIssues.length > 0) {
    issues.push(...ruleIssues);
    return empty;
  }

  // Rank the field with a config that carries only what the ranker needs.
  const scoringShim: ScoringConfig = { mode: input.scoring_mode };
  const ranked = rankResults(input.results, scoringShim);

  // ---- Nobody qualified ----------------------------------------------------
  if (ranked.length === 0) {
    if (config.escrow_on_no_qualified) {
      return {
        ...empty,
        ok: true,
        escrow_cents: netPurse,
        issues: [
          {
            field: 'results',
            code: 'ESCROWED_NO_QUALIFIED',
            severity: 'warning',
            message:
              'No qualified contestants. The purse is held in escrow and ' +
              'carries to next year as added money for this rodeo.',
          },
        ],
      };
    }
    return {
      ...empty,
      ok: true,
      unpaid_cents: netPurse,
      issues: [
        {
          field: 'results',
          code: 'NO_QUALIFIED',
          severity: 'warning',
          message:
            'No qualified contestants and this config does not escrow. ' +
            'The purse requires a manual decision.',
        },
      ],
    };
  }

  // ---- D-format ------------------------------------------------------------
  if (config.is_d_format) {
    if (!config.d_format) {
      issues.push({
        field: 'd_format',
        code: 'MISSING_D_CONFIG',
        severity: 'error',
        message: 'Config is marked is_d_format but carries no d_format block.',
      });
      return empty;
    }
    return payDFormat(netPurse, input, config.d_format, rule, {
      ...empty,
      ok: true,
    });
  }

  if (isTeamEvent) {
    const team = payTeamPurse(netPurse, ranked, rule, config);
    if (team.issues.some((i) => i.severity === 'error')) {
      issues.push(...team.issues);
      return empty;
    }
    return {
      ok: true,
      issues: [...issues, ...team.issues],
      gross_purse_cents: grossPurse,
      fees,
      net_purse_cents: netPurse,
      escrow_cents: 0,
      unpaid_cents: team.unpaidCents,
      payouts: team.lines,
    };
  }

  const { lines, unpaidCents } = payOnePurse(netPurse, ranked, rule, config);

  return {
    ok: true,
    issues,
    gross_purse_cents: grossPurse,
    fees,
    net_purse_cents: netPurse,
    escrow_cents: 0,
    unpaid_cents: unpaidCents,
    payouts: lines,
  };
}

// ---------------------------------------------------------------------------
// D-format
// ---------------------------------------------------------------------------

function payDFormat(
  netPurseCents: number,
  input: PayoutCalculationInput,
  dConfig: DFormatConfig,
  rule: PayoutRule,
  base: PayoutResult,
): PayoutResult {
  const { assignments, error } = assignDDivisions(input.results, dConfig);

  if (error) {
    return {
      ...base,
      ok: false,
      issues: [
        {
          field: 'd_format',
          code: 'INVALID_D_CONFIG',
          severity: 'error',
          message: error,
        },
      ],
    };
  }

  // Divisions with nobody in them do not get paid; their share is redistributed
  // across the divisions that filled, in proportion to the configured
  // percentages. Paying an empty division would strand money in the account.
  const occupied = new Set(assignments.map((a) => a.division));
  const weights = dConfig.division_pcts.map((pct, i) =>
    occupied.has(i + 1) ? pct : 0,
  );

  const divisionCents = allocate(netPurseCents, weights);
  const lines: PayoutLine[] = [];
  let unpaid = 0;

  for (let d = 1; d <= dConfig.divisions; d++) {
    const pool = divisionCents[d - 1];
    if (pool <= 0) continue;

    const inDivision: Rankable[] = assignments
      .filter((a) => a.division === d)
      .map((a) => ({
        contestant_id: a.contestant_id,
        status: 'official' as const,
        final_time: a.final_time,
        final_score: null,
      }));

    const ranked = rankResults(inDivision, { mode: 'timed' });
    const result = payOnePurse(pool, ranked, rule, input.payout_config, 'd_division');

    for (const line of result.lines) lines.push({ ...line, d_division: d });
    unpaid += result.unpaidCents;
  }

  return {
    ...base,
    ok: true,
    unpaid_cents: unpaid,
    payouts: lines,
  };
}

// ---------------------------------------------------------------------------
// Multi-round: go-round money plus average money
// ---------------------------------------------------------------------------

export interface MultiRoundInput {
  payout_config: PayoutConfig;
  scoring_mode: ScoringMode;
  /** go_round number -> that round's field. */
  results_by_round: Map<number, Rankable[]>;
  /** The average standings, already aggregated across all rounds. */
  average_results: Rankable[];
  entries: Entryish[];
  added_money_cents: number;
  entry_fee_cents: number;
}

export function calculateMultiRoundPayout(
  input: MultiRoundInput,
): PayoutResult {
  const config = input.payout_config;
  const split = config.go_round_average_split;

  const counted = input.entries.filter((e) => COUNTS_AS_ENTERED.has(e.status));
  const isTeamEvent = config.team_payout !== undefined;
  const teamCount = isTeamEvent
    ? new Set(
        [...input.results_by_round.values()]
          .flat()
          .filter((r) => r.team_members?.length)
          .map((r) => r.contestant_id),
      ).size
    : 0;
  const numEntries = isTeamEvent && teamCount > 0 ? teamCount : counted.length;
  const entryFeePool = counted.reduce(
    (s, e) => s + (e.entry_fee_cents ?? input.entry_fee_cents),
    0,
  );
  const grossPurse = input.added_money_cents + entryFeePool;
  const fees = calculateFees(grossPurse, numEntries, config);
  const netPurse = grossPurse - fees.total_cents;

  const base: PayoutResult = {
    ok: false,
    issues: [],
    gross_purse_cents: grossPurse,
    fees,
    net_purse_cents: netPurse,
    escrow_cents: 0,
    unpaid_cents: 0,
    payouts: [],
  };

  if (!split) {
    return {
      ...base,
      issues: [
        {
          field: 'go_round_average_split',
          code: 'MISSING_SPLIT',
          severity: 'error',
          message: 'Multi-round payout requires go_round_average_split.',
        },
      ],
    };
  }

  const rule = findPayoutRule(numEntries, config);
  if (!rule) {
    return {
      ...base,
      issues: [
        {
          field: 'payout_rules',
          code: 'NO_MATCHING_RULE',
          severity: 'error',
          message: `No payout rule covers ${numEntries} entries.`,
        },
      ],
    };
  }

  const numRounds = input.results_by_round.size;
  if (numRounds === 0) {
    return {
      ...base,
      issues: [
        {
          field: 'results_by_round',
          code: 'NO_ROUNDS',
          severity: 'error',
          message: 'No go-rounds supplied.',
        },
      ],
    };
  }

  // Split the net purse between the go-round pool and the average pool, then
  // the go-round pool evenly across the rounds — all in one allocation so the
  // whole thing still reconciles to the cent.
  const [goRoundPool, averagePool] = allocate(netPurse, [
    split.go_round_pct,
    split.average_pct,
  ]);
  const perRound = splitEvenly(goRoundPool, numRounds);

  const lines: PayoutLine[] = [];
  let unpaid = 0;

  const rounds = [...input.results_by_round.keys()].sort((a, b) => a - b);
  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];
    const field = input.results_by_round.get(round)!;
    const ranked = rankResults(field, { mode: input.scoring_mode });
    const result = isTeamEvent
      ? payTeamPurse(perRound[i], ranked, rule, config, 'go_round')
      : payOnePurse(perRound[i], ranked, rule, config, 'go_round');
    for (const line of result.lines) lines.push({ ...line, go_round: round });
    unpaid += result.unpaidCents;
  }

  const averageRanked = rankResults(input.average_results, {
    mode: input.scoring_mode,
  });
  const avg = isTeamEvent
    ? payTeamPurse(averagePool, averageRanked, rule, config, 'average')
    : payOnePurse(averagePool, averageRanked, rule, config, 'average');
  lines.push(...avg.lines);
  unpaid += avg.unpaidCents;

  return { ...base, ok: true, unpaid_cents: unpaid, payouts: lines };
}

// ---------------------------------------------------------------------------
// IPRA three-head average (§6.3)
// ---------------------------------------------------------------------------

/**
 * IPRA splits a three-head purse 2:2:3 across round 1, round 2 and the
 * average, after setting aside $25 per entry for the short go.
 */
export function calculateIPRAThreeHead(
  totalPrizeCents: number,
  numEntries: number,
  resultsByRound: Map<number, Rankable[]>,
  averageResults: Rankable[],
  rule: PayoutRule,
  config: PayoutConfig,
  scoringMode: ScoringMode,
): { pools: Record<string, number>; payouts: PayoutLine[]; unpaid_cents: number } {
  const shortGoPool = 2500 * numEntries; // $25.00 per entry, in cents
  const remaining = Math.max(0, totalPrizeCents - shortGoPool);

  const [go1, go2, average] = allocate(remaining, [2, 2, 3]);
  const pools = { short_go: shortGoPool, go_round_1: go1, go_round_2: go2, average };

  const lines: PayoutLine[] = [];
  let unpaid = 0;

  for (const [round, pool] of [
    [1, go1],
    [2, go2],
  ] as [number, number][]) {
    const ranked = rankResults(resultsByRound.get(round) ?? [], {
      mode: scoringMode,
    });
    const result = payOnePurse(pool, ranked, rule, config, 'go_round');
    for (const line of result.lines) lines.push({ ...line, go_round: round });
    unpaid += result.unpaidCents;
  }

  const avgRanked = rankResults(averageResults, { mode: scoringMode });
  const avg = payOnePurse(average, avgRanked, rule, config, 'average');
  lines.push(...avg.lines);
  unpaid += avg.unpaidCents;

  return { pools, payouts: lines, unpaid_cents: unpaid };
}

// ---------------------------------------------------------------------------
// Day money (§6.4) — roughstock, multi-performance rodeos only
// ---------------------------------------------------------------------------

export interface DayMoneyInput {
  is_roughstock: boolean;
  num_performances: number;
  /** Extra fee charged for the paid performance, in cents. */
  additional_entry_fee_cents: number;
  paid_performance_entries: number;
  performance_results: Rankable[];
}

export interface DayMoneyResult {
  applies: boolean;
  pool_cents: number;
  /** True when nobody qualified: the pool rolls into the total event payout. */
  rollover: boolean;
  qualified_count: number;
  payouts: PayoutLine[];
}

export function calculateDayMoney(input: DayMoneyInput): DayMoneyResult {
  if (!input.is_roughstock || input.num_performances <= 1) {
    return {
      applies: false,
      pool_cents: 0,
      rollover: false,
      qualified_count: 0,
      payouts: [],
    };
  }

  // Half of the additional entry fees make the day-money pool; the other half
  // goes to the total event payout.
  const additional =
    input.additional_entry_fee_cents * input.paid_performance_entries;
  const pool = Math.floor(additional / 2);

  const qualified = input.performance_results.filter(
    (r) => r.status === 'official',
  );

  if (qualified.length === 0) {
    return {
      applies: true,
      pool_cents: pool,
      rollover: true,
      qualified_count: 0,
      payouts: [],
    };
  }

  const shares = splitEvenly(pool, qualified.length);
  assertReconciles(shares, pool, 'day money');

  return {
    applies: true,
    pool_cents: pool,
    rollover: false,
    qualified_count: qualified.length,
    payouts: qualified.map((r, i) => ({
      contestant_id: r.contestant_id,
      type: 'day_money' as const,
      amount_cents: shares[i],
      prize_cents: shares[i],
      ground_money_cents: 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Stock contractor compensation (§6.7) and PESI (§6.8)
// ---------------------------------------------------------------------------

export function calculateStockContractorPay(
  contestantPayouts: PayoutLine[],
  config: PayoutConfig,
  /** contractor user id -> number of head they supplied that were competed on */
  headByContractor: Map<string, number>,
): PayoutLine[] {
  const pct = config.stock_contractor_pct ?? 0;
  if (pct <= 0 || headByContractor.size === 0) return [];

  const totalPayout = contestantPayouts.reduce(
    (s, p) => s + p.amount_cents,
    0,
  );
  const pool = pctOfCents(totalPayout, pct);
  if (pool <= 0) return [];

  // Distributed in proportion to head supplied. The architecture leaves this
  // as "implementation depends on stock draw data" and returns one unattributed
  // lump with contestant_id absent, which cannot be disbursed to anybody.
  const contractors = [...headByContractor.entries()];
  const shares = allocate(
    pool,
    contractors.map(([, head]) => head),
  );
  assertReconciles(shares, pool, 'stock contractor pay');

  return contractors.map(([contractorId, head], i) => ({
    contestant_id: contractorId,
    type: 'stock_contractor' as const,
    amount_cents: shares[i],
    prize_cents: shares[i],
    ground_money_cents: 0,
    description: `${(pct * 100).toFixed(0)}% of contestant payout, ${head} head`,
  }));
}

/** WPRA PESI: 60% to the offspring owner, 40% to the stallion owner. */
export function calculatePESIBonus(
  bonusCents: number,
  animal: {
    pesi_enrolled: boolean;
    contractor_id: string | null;
    sire_contractor_id: string | null;
  },
): PayoutLine[] {
  if (!animal.pesi_enrolled || bonusCents <= 0) return [];
  if (!animal.contractor_id || !animal.sire_contractor_id) return [];

  const [offspring, stallion] = allocate(bonusCents, [0.6, 0.4]);

  return [
    {
      contestant_id: animal.contractor_id,
      type: 'pesi_offspring',
      amount_cents: offspring,
      prize_cents: offspring,
      ground_money_cents: 0,
      description: 'PESI offspring owner share (60%)',
    },
    {
      contestant_id: animal.sire_contractor_id,
      type: 'pesi_stallion',
      amount_cents: stallion,
      prize_cents: stallion,
      ground_money_cents: 0,
      description: 'PESI stallion owner share (40%)',
    },
  ];
}
