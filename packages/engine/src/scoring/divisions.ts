/**
 * Numbered (handicap) roping divisions.
 *
 * Not in the architecture at all — and it is the format most of this
 * platform's ropers actually enter. USTRC and WSTR run classified,
 * number-capped divisions rather than open competition: every roper carries a
 * handicap number, a team's numbers must add up to no more than the division,
 * and most divisions additionally cap what any single end may be so a very
 * high-numbered header cannot carry a beginner heeler into a low division.
 *
 * Getting this wrong is not cosmetic. A team that ropes an ineligible division
 * is disqualified after the fact and the money is re-paid, which is exactly
 * the sort of after-the-fact correction the immutable ledger is designed to
 * make painful. The check belongs before the entry is accepted.
 *
 * ---------------------------------------------------------------------------
 * RULE PROVENANCE — see docs/RULES.md
 *
 * Confirmed for 2026:
 *   - USTRC barrier penalty is 5 seconds, not the 10 seconds PRCA assesses.
 *   - USTRC one-leg (single hind leg) catch is a 5-second penalty.
 *   - USTRC TRIAD numbers headers 1-9 and heelers 1-10.
 *   - Divisions carry per-end caps (a #7 with a header cap of 4 and a heeler
 *     cap of 3; WSTR's #7.5 capped at a #4 on both ends, with no #4.5 heading
 *     or heeling in it).
 *
 * NOT confirmed, and therefore not hard-coded anywhere: the full 2026 division
 * ladder for either association, and the exact wording of the Elite rule.
 * Division tables are DATA, loaded from `rodeo_events.division_config`, and
 * the shipped templates are flagged `unverified` until a rulebook is in hand.
 * ---------------------------------------------------------------------------
 */

import type { ValidationIssue } from '../types/index.ts';

export interface DivisionRule {
  /** Display name: "#9.5", "#12", "Open". */
  name: string;
  /**
   * Maximum combined number for the team. Null means open — no cap, which is
   * how an Open or a #15+ division is expressed.
   */
  max_combined: number | null;
  /** Minimum combined number, where a division has a floor. */
  min_combined?: number | null;
  /** Highest number allowed on the heading end. */
  header_cap?: number | null;
  /** Highest number allowed on the heeling end. */
  heeler_cap?: number | null;
  /**
   * Numbers barred from this division outright regardless of the combined
   * total — WSTR bars #4.5 ropers from the #7.5, for instance.
   */
  excluded_numbers?: number[];
  /**
   * Elite/protected ropers, however the association defines them, may be
   * barred from divisions at or below this ceiling.
   */
  elite_excluded?: boolean;
}

export interface DivisionConfig {
  /** 'USTRC' | 'WSTR' | 'NTR' | producer's own. */
  system: string;
  season?: string;
  divisions: DivisionRule[];
  /**
   * Some associations require the heeler's number to be at least the header's,
   * to stop a high header dragging a low heeler down a division. Off unless a
   * config turns it on.
   */
  heeler_at_least_header?: boolean;
  unverified?: boolean;
  unverified_note?: string;
}

export interface TeamNumbers {
  header_id: string;
  header_number: number;
  heeler_id: string;
  heeler_number: number;
  /** Either roper flagged elite/protected by the association. */
  header_elite?: boolean;
  heeler_elite?: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  combined: number;
  division: string;
  issues: ValidationIssue[];
}

/**
 * Can this team enter this division?
 *
 * Every failure is reported, not just the first, so a secretary at the entry
 * desk sees everything wrong with the team in one pass instead of fixing one
 * problem and being told about the next.
 */
export function checkDivisionEligibility(
  team: TeamNumbers,
  division: DivisionRule,
  config?: Pick<DivisionConfig, 'heeler_at_least_header'>,
): EligibilityResult {
  const issues: ValidationIssue[] = [];

  // Handicap numbers come in halves (#4.5). Work in tenths so the arithmetic
  // is exact -- 4.5 + 5.5 must equal 10, not 9.999999999999998.
  const combined =
    Math.round(team.header_number * 10 + team.heeler_number * 10) / 10;

  if (division.max_combined !== null && division.max_combined !== undefined) {
    if (combined > division.max_combined) {
      issues.push({
        field: 'combined',
        code: 'OVER_DIVISION_CAP',
        severity: 'error',
        message:
          `Team is a #${combined}; the ${division.name} caps at ` +
          `#${division.max_combined}.`,
      });
    }
  }

  if (division.min_combined !== null && division.min_combined !== undefined) {
    if (combined < division.min_combined) {
      issues.push({
        field: 'combined',
        code: 'UNDER_DIVISION_FLOOR',
        severity: 'error',
        message:
          `Team is a #${combined}; the ${division.name} has a floor of ` +
          `#${division.min_combined}.`,
      });
    }
  }

  if (
    division.header_cap !== null &&
    division.header_cap !== undefined &&
    team.header_number > division.header_cap
  ) {
    issues.push({
      field: 'header_number',
      code: 'HEADER_OVER_END_CAP',
      severity: 'error',
      message:
        `Header is a #${team.header_number}; the ${division.name} caps the ` +
        `heading end at #${division.header_cap}.`,
    });
  }

  if (
    division.heeler_cap !== null &&
    division.heeler_cap !== undefined &&
    team.heeler_number > division.heeler_cap
  ) {
    issues.push({
      field: 'heeler_number',
      code: 'HEELER_OVER_END_CAP',
      severity: 'error',
      message:
        `Heeler is a #${team.heeler_number}; the ${division.name} caps the ` +
        `heeling end at #${division.heeler_cap}.`,
    });
  }

  for (const barred of division.excluded_numbers ?? []) {
    if (team.header_number === barred) {
      issues.push({
        field: 'header_number',
        code: 'NUMBER_EXCLUDED',
        severity: 'error',
        message: `A #${barred} may not head in the ${division.name}.`,
      });
    }
    if (team.heeler_number === barred) {
      issues.push({
        field: 'heeler_number',
        code: 'NUMBER_EXCLUDED',
        severity: 'error',
        message: `A #${barred} may not heel in the ${division.name}.`,
      });
    }
  }

  if (division.elite_excluded) {
    if (team.header_elite) {
      issues.push({
        field: 'header_id',
        code: 'ELITE_EXCLUDED',
        severity: 'error',
        message: `Header is classified elite and may not enter the ${division.name}.`,
      });
    }
    if (team.heeler_elite) {
      issues.push({
        field: 'heeler_id',
        code: 'ELITE_EXCLUDED',
        severity: 'error',
        message: `Heeler is classified elite and may not enter the ${division.name}.`,
      });
    }
  }

  if (config?.heeler_at_least_header && team.heeler_number < team.header_number) {
    issues.push({
      field: 'heeler_number',
      code: 'HEELER_BELOW_HEADER',
      severity: 'error',
      message:
        `Heeler (#${team.heeler_number}) must be at least the header's ` +
        `number (#${team.header_number}) in this association.`,
    });
  }

  if (team.header_id === team.heeler_id) {
    issues.push({
      field: 'heeler_id',
      code: 'SAME_ROPER_BOTH_ENDS',
      severity: 'error',
      message: 'A roper cannot head and heel for themselves.',
    });
  }

  return {
    eligible: issues.length === 0,
    combined,
    division: division.name,
    issues,
  };
}

/**
 * Every division in the config this team can legally enter, lowest first.
 *
 * Ropers enter down as far as they are allowed — the lower the division the
 * softer the field — so the entry screen wants the whole list, not just a
 * yes/no on the one they picked.
 */
export function eligibleDivisions(
  team: TeamNumbers,
  config: DivisionConfig,
): DivisionRule[] {
  return config.divisions
    .filter((d) => checkDivisionEligibility(team, d, config).eligible)
    .sort((a, b) => {
      const av = a.max_combined ?? Number.POSITIVE_INFINITY;
      const bv = b.max_combined ?? Number.POSITIVE_INFINITY;
      return av - bv;
    });
}
