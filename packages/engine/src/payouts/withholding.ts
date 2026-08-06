/**
 * Cross-border tax withholding.
 *
 * Architecture ref: §6.6.
 *
 * This module computes an amount. It does not give tax advice, and every rule
 * carries an advisory string that the UI is required to surface alongside the
 * number. Producers pay non-resident contestants in three jurisdictions with
 * mandatory withholding; getting it wrong is the producer's liability, so the
 * engine's job is to make the deduction visible and explainable, not to
 * quietly net it off.
 */

import type { WithholdingResult, WithholdingRule } from '../types/index.ts';

export const WITHHOLDING_RULES: Record<string, WithholdingRule> = {
  CA: {
    code: 'reg_105',
    name: 'Regulation 105',
    rate: 0.15,
    form: 'T4A-NR',
    exemptions: ['waiver_approved', 'treaty_exempt'],
    advisory:
      'Canada withholds 15% from amounts paid to non-residents for services ' +
      'rendered in Canada. A CRA waiver may reduce or remove it. Consult a ' +
      'Canadian tax advisor before relying on an exemption.',
  },
  AU: {
    code: 'payg_no_abn',
    name: 'PAYG Withholding (No ABN)',
    rate: 0.47,
    form: 'PAYG Payment Summary',
    exemptions: ['abn_quoted', 'hobby_recreation', 'under_75_threshold'],
    advisory:
      'Australia requires 47% PAYG withholding where no ABN is quoted. ' +
      'Quoting a valid ABN, or a hobby/recreational declaration, removes it. ' +
      'Consult an Australian tax advisor.',
  },
  BR: {
    code: 'irrf',
    name: 'IRRF',
    rate: 0.15,
    rate_tax_haven: 0.25,
    form: 'Nota Fiscal',
    exemptions: [],
    advisory:
      'Brazil withholds IRRF at 15%, or 25% where the recipient is resident ' +
      'in a listed tax haven. Electronic Nota Fiscal invoicing is required. ' +
      'Consult a Brazilian tax advisor.',
  },
};

export interface WithholdingContext {
  /** ISO 3166-1 alpha-2 of the contestant's tax residence. */
  contestant_country: string;
  /** ISO 3166-1 alpha-2 of where the rodeo was held. */
  rodeo_country: string;
  /** Exemption codes the contestant has documented. */
  exemptions?: string[];
  /** Brazil only: recipient is resident in a listed tax haven. */
  tax_haven_resident?: boolean;
  /** Australia only: a valid ABN was quoted at entry. */
  abn_quoted?: boolean;
}

/**
 * Which rule, if any, applies.
 *
 * Withholding is a function of where the money is EARNED, not where the
 * contestant lives — the rodeo's country selects the regime, and residence
 * decides whether the non-resident rule bites. Australia is the exception:
 * PAYG-without-ABN applies to residents and non-residents alike, which is why
 * §6.6's comment says "OR when specific domestic rules apply (AU no-ABN)".
 */
export function determineApplicableRule(
  ctx: WithholdingContext,
): WithholdingRule | null {
  const rodeo = ctx.rodeo_country?.toUpperCase();
  const contestant = ctx.contestant_country?.toUpperCase();

  if (rodeo === 'AU') {
    // Domestic rule: no ABN, withhold, resident or not.
    return ctx.abn_quoted ? null : WITHHOLDING_RULES.AU;
  }

  if (!rodeo || rodeo === contestant) return null;

  return WITHHOLDING_RULES[rodeo] ?? null;
}

export function applyWithholding(
  grossCents: number,
  ctx: WithholdingContext,
): WithholdingResult {
  const rule = determineApplicableRule(ctx);

  if (!rule) {
    return {
      gross_cents: grossCents,
      withholding_cents: 0,
      net_cents: grossCents,
      rate: 0,
      advisory: null,
    };
  }

  const claimed = ctx.exemptions ?? [];
  const matched = claimed.find((e) => rule.exemptions.includes(e));
  if (matched) {
    return {
      gross_cents: grossCents,
      withholding_cents: 0,
      net_cents: grossCents,
      rate: 0,
      rule,
      exemption_applied: matched,
      advisory: rule.advisory,
    };
  }

  const rate =
    ctx.tax_haven_resident && rule.rate_tax_haven !== undefined
      ? rule.rate_tax_haven
      : rule.rate;

  // Rounded down so the contestant is never short-paid by a rounding artefact;
  // the remittance is the exact complement of what was disbursed.
  const withholding = Math.floor(grossCents * rate);

  return {
    gross_cents: grossCents,
    withholding_cents: withholding,
    net_cents: grossCents - withholding,
    rate,
    rule,
    advisory: rule.advisory,
  };
}
