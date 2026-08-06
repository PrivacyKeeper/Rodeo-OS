/**
 * Cent-exact money arithmetic.
 *
 * The architecture's payout engine rounds every line independently:
 *
 *     private roundCents(amount: number): number {
 *         return Math.round(amount * 100) / 100;
 *     }
 *
 * Rounding each share on its own does not preserve the total. Split a $100
 * purse three ways and you disburse $99.99; split 50/30/20 of a purse that
 * ends in an odd cent and you are over or under by one. §7.4 lists
 * "Payout reconciliation (sum of payouts = net purse)" as a tracked metric
 * with a target of zero errors, so the rounding has to be done as an
 * allocation over the whole purse rather than one line at a time.
 *
 * `allocate()` uses the largest-remainder method: floor every share, then hand
 * the leftover cents out one each, to the shares with the largest discarded
 * fraction first. The result always sums to exactly the input.
 *
 * See docs/SPEC-DELTAS.md D16.
 */

/** Dollars (or any major unit) to integer cents. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Integer cents back to a major-unit number, for display only. */
export function fromCents(cents: number): number {
  return cents / 100;
}

export function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

/**
 * Split `totalCents` across `weights` so the parts sum to exactly totalCents.
 *
 * Weights need not sum to 1; they are normalised. A zero or negative total
 * yields all zeros. Ties in the discarded fraction are broken by original
 * index, which keeps the allocation deterministic and therefore re-runnable —
 * the payout engine is required to be idempotent (§6.1).
 */
export function allocate(totalCents: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  if (totalCents <= 0) return weights.map(() => 0);

  const weightSum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (weightSum <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (Math.max(0, w) / weightSum) * totalCents);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = totalCents - floors.reduce((s, v) => s + v, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));

  const out = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++) {
    out[order[k].i] += 1;
    remainder -= 1;
  }

  return out;
}

/**
 * Split `totalCents` into `parts` equal shares that sum to exactly totalCents.
 * Used for ground money and for splitting combined places among tied
 * contestants.
 */
export function splitEvenly(totalCents: number, parts: number): number[] {
  if (parts <= 0) return [];
  return allocate(totalCents, new Array(parts).fill(1));
}

/** Percentage of a cent amount, rounded half away from zero. */
export function pctOfCents(cents: number, pct: number): number {
  return Math.round(cents * pct);
}

/** Throws if the lines do not add up. Used as a post-condition in the engine. */
export function assertReconciles(
  parts: number[],
  expectedTotal: number,
  label: string,
): void {
  const sum = parts.reduce((s, v) => s + v, 0);
  if (sum !== expectedTotal) {
    throw new Error(
      `${label}: allocation does not reconcile (${sum} != ${expectedTotal} cents)`,
    );
  }
}
