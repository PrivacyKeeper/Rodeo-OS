/**
 * The draw.
 *
 * Architecture ref: §4.1 "DRAW", Appendix C Phase 1.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS DETERMINISTIC
 * ---------------------------------------------------------------------------
 * A draw decides who competes when, on which animal, in front of how many
 * people. Contestants care enormously, and every association has a rule about
 * it being random and witnessed. So the two requirements pull against each
 * other: it has to be unpredictable to the people entering, and it has to be
 * REPRODUCIBLE afterwards.
 *
 * Both are satisfied by seeding. The secretary generates a draw with a seed;
 * the seed is recorded with the draw and can be published. Anyone can re-run
 * it and get the identical result, which is what makes "the draw was witnessed"
 * a checkable claim rather than a promise. Change one entry and the whole draw
 * changes, so it cannot be quietly tuned after the fact.
 *
 * `Math.random()` is never used here — it cannot be replayed, and the engine
 * forbids it everywhere for the same reason the payout engine does.
 * ---------------------------------------------------------------------------
 */

import type { ValidationIssue } from '../types/index.ts';

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/** FNV-1a. Turns a human-readable seed into a 32-bit state. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32. Small, fast, and good enough for a draw — this is fairness, not
 * cryptography. What matters is that it is uniform and exactly replayable.
 */
export function makeRng(seed: string): () => number {
  let a = hashSeed(seed);
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates, unbiased. The naive `sort(() => rng() - 0.5)` shuffle is not
 * uniform and would hand out favourable positions more often than chance.
 */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DrawMethod =
  | 'random'
  | 'random_by_division'
  | 'buddy_group'
  | 'sequential_by_entry'
  | 'seeded_by_standings'
  | 'reverse_standings'
  | 'manual';

export interface DrawEntry {
  entry_id: string;
  contestant_id: string;
  /** Ropers who travel together are drawn into the same performance. */
  buddy_group_id?: string | null;
  /** Handicap or D division, for `random_by_division`. */
  division?: string | null;
  /** Season standing, for the seeded methods. Lower is better. */
  standing?: number | null;
  /** Order the entry arrived, for `sequential_by_entry`. */
  entered_seq?: number;
  /**
   * A contestant entered more than once must not draw two runs in the same
   * performance — they cannot be in two places at once.
   */
  slot?: number;
}

export interface PerformanceSlot {
  performance_number: number;
  /** 'performance' | 'slack' | 'short_go' | 'finals' */
  performance_type: string;
  /** How many runs this performance can hold. Null = unlimited (slack). */
  capacity: number | null;
}

export interface DrawRequest {
  entries: DrawEntry[];
  performances: PerformanceSlot[];
  /** Recorded with the draw and publishable. Same seed, same draw. */
  seed: string;
  method: DrawMethod;
  go_round?: number;
}

export interface DrawAssignment {
  entry_id: string;
  contestant_id: string;
  performance_number: number;
  /** Order within the performance, 1-based. */
  draw_position: number;
  go_round: number;
}

export interface DrawResult {
  ok: boolean;
  seed: string;
  method: DrawMethod;
  assignments: DrawAssignment[];
  issues: ValidationIssue[];
  /** Entries that could not be placed, with the reason. */
  unplaced: { entry_id: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

function orderEntries(
  entries: DrawEntry[],
  method: DrawMethod,
  rng: () => number,
): DrawEntry[] {
  switch (method) {
    case 'sequential_by_entry':
      // Order of entry. Ties on seq fall back to entry_id so the result is
      // stable rather than dependent on array order.
      return [...entries].sort(
        (a, b) =>
          (a.entered_seq ?? 0) - (b.entered_seq ?? 0) ||
          a.entry_id.localeCompare(b.entry_id),
      );

    case 'seeded_by_standings':
      // Best-ranked first. Unranked contestants go last, shuffled among
      // themselves so a permit holder is not permanently at the back.
      return [
        ...entries
          .filter((e) => e.standing != null)
          .sort((a, b) => a.standing! - b.standing!),
        ...shuffle(entries.filter((e) => e.standing == null), rng),
      ];

    case 'reverse_standings':
      return [
        ...shuffle(entries.filter((e) => e.standing == null), rng),
        ...entries
          .filter((e) => e.standing != null)
          .sort((a, b) => b.standing! - a.standing!),
      ];

    case 'manual':
      return [...entries];

    default:
      // Sort by entry_id BEFORE shuffling. Without it the draw depends on the
      // order rows came back from the database, and two runs with the same
      // seed could differ — which would break the whole reproducibility claim.
      return shuffle(
        [...entries].sort((a, b) => a.entry_id.localeCompare(b.entry_id)),
        rng,
      );
  }
}

// ---------------------------------------------------------------------------
// Draw generation
// ---------------------------------------------------------------------------

/**
 * Assign every entry to a performance and a position within it.
 *
 * Performances fill in a balanced way rather than front-to-back: a rodeo with
 * three performances and thirty entries puts ten in each, not fifteen, ten and
 * five. Slack (capacity null) absorbs whatever will not fit.
 */
export function generateDraw(request: DrawRequest): DrawResult {
  const issues: ValidationIssue[] = [];
  const unplaced: { entry_id: string; reason: string }[] = [];
  const goRound = request.go_round ?? 1;
  const rng = makeRng(`${request.seed}:round${goRound}`);

  if (request.entries.length === 0) {
    issues.push({
      field: 'entries',
      code: 'NO_ENTRIES',
      severity: 'error',
      message: 'There is nothing to draw.',
    });
    return { ok: false, seed: request.seed, method: request.method, assignments: [], issues, unplaced };
  }

  if (request.performances.length === 0) {
    issues.push({
      field: 'performances',
      code: 'NO_PERFORMANCES',
      severity: 'error',
      message: 'A draw needs at least one performance or slack to draw into.',
    });
    return { ok: false, seed: request.seed, method: request.method, assignments: [], issues, unplaced };
  }

  const duplicates = request.entries
    .map((e) => e.entry_id)
    .filter((id, i, all) => all.indexOf(id) !== i);
  if (duplicates.length > 0) {
    issues.push({
      field: 'entries',
      code: 'DUPLICATE_ENTRY',
      severity: 'error',
      message: `Entry appears more than once: ${[...new Set(duplicates)].join(', ')}.`,
    });
    return { ok: false, seed: request.seed, method: request.method, assignments: [], issues, unplaced };
  }

  const perfs = [...request.performances].sort(
    (a, b) => a.performance_number - b.performance_number,
  );
  const counts = new Map<number, number>(perfs.map((p) => [p.performance_number, 0]));
  // A contestant cannot run twice in the same performance.
  const busy = new Map<number, Set<string>>(
    perfs.map((p) => [p.performance_number, new Set<string>()]),
  );

  const capacityOf = (p: PerformanceSlot) => p.capacity ?? Number.POSITIVE_INFINITY;
  const totalCapacity = perfs.reduce((s, p) => s + capacityOf(p), 0);
  if (totalCapacity < request.entries.length) {
    issues.push({
      field: 'performances',
      code: 'INSUFFICIENT_CAPACITY',
      severity: 'error',
      message:
        `${request.entries.length} entries but only ${totalCapacity} slots. ` +
        'Add a performance, add slack, or raise a capacity.',
    });
    return { ok: false, seed: request.seed, method: request.method, assignments: [], issues, unplaced };
  }

  /** The emptiest performance that can still take this contestant. */
  const pickPerformance = (contestantId: string): PerformanceSlot | null => {
    let best: PerformanceSlot | null = null;
    let bestLoad = Number.POSITIVE_INFINITY;

    for (const p of perfs) {
      const used = counts.get(p.performance_number)!;
      if (used >= capacityOf(p)) continue;
      if (busy.get(p.performance_number)!.has(contestantId)) continue;

      // Balance by how full a performance is relative to its own capacity, so
      // a small slack does not soak up everything.
      const load = p.capacity === null ? used / 1000 : used / p.capacity;
      if (load < bestLoad) {
        bestLoad = load;
        best = p;
      }
    }
    return best;
  };

  const assignments: DrawAssignment[] = [];

  const place = (entry: DrawEntry, forced?: PerformanceSlot): boolean => {
    const perf = forced ?? pickPerformance(entry.contestant_id);
    if (!perf) return false;

    counts.set(perf.performance_number, counts.get(perf.performance_number)! + 1);
    busy.get(perf.performance_number)!.add(entry.contestant_id);
    assignments.push({
      entry_id: entry.entry_id,
      contestant_id: entry.contestant_id,
      performance_number: perf.performance_number,
      draw_position: 0, // filled in below
      go_round: goRound,
    });
    return true;
  };

  const ordered = orderEntries(request.entries, request.method, rng);

  // ---- Buddy groups first ------------------------------------------------
  // Travel partners asked to run in the same performance, so they get first
  // call on the room. Placing them after the singles would leave groups
  // stranded across performances.
  if (request.method === 'buddy_group') {
    const groups = new Map<string, DrawEntry[]>();
    const singles: DrawEntry[] = [];

    for (const entry of ordered) {
      if (entry.buddy_group_id) {
        const g = groups.get(entry.buddy_group_id) ?? [];
        g.push(entry);
        groups.set(entry.buddy_group_id, g);
      } else {
        singles.push(entry);
      }
    }

    // Biggest groups first: they are the hardest to fit.
    const bySize = [...groups.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );

    for (const [groupId, members] of bySize) {
      const target = perfs.find((p) => {
        const used = counts.get(p.performance_number)!;
        if (used + members.length > capacityOf(p)) return false;
        const inUse = busy.get(p.performance_number)!;
        return members.every((m) => !inUse.has(m.contestant_id));
      });

      if (!target) {
        // The group will not fit anywhere together. Place them individually
        // rather than refusing the whole draw, and say so.
        issues.push({
          field: `buddy_group.${groupId}`,
          code: 'BUDDY_GROUP_SPLIT',
          severity: 'warning',
          message:
            `Buddy group of ${members.length} would not fit in one performance ` +
            'and has been split.',
        });
        for (const m of members) {
          if (!place(m)) unplaced.push({ entry_id: m.entry_id, reason: 'no slot available' });
        }
        continue;
      }

      for (const m of members) place(m, target);
    }

    for (const s of singles) {
      if (!place(s)) unplaced.push({ entry_id: s.entry_id, reason: 'no slot available' });
    }
  } else {
    for (const entry of ordered) {
      if (!place(entry)) {
        unplaced.push({
          entry_id: entry.entry_id,
          reason: 'no performance with room that the contestant is not already in',
        });
      }
    }
  }

  // ---- Positions within each performance ---------------------------------
  // Shuffled independently of the performance assignment. Drawing up first or
  // last matters — ground conditions change and later ropers see the times —
  // so position is its own random event, not a by-product of who was placed
  // first.
  const byPerf = new Map<number, DrawAssignment[]>();
  for (const a of assignments) {
    const bucket = byPerf.get(a.performance_number) ?? [];
    bucket.push(a);
    byPerf.set(a.performance_number, bucket);
  }

  for (const [perfNumber, bucket] of byPerf) {
    const order =
      request.method === 'sequential_by_entry' || request.method === 'manual'
        ? bucket
        : shuffle(
            [...bucket].sort((a, b) => a.entry_id.localeCompare(b.entry_id)),
            makeRng(`${request.seed}:round${goRound}:perf${perfNumber}`),
          );
    order.forEach((a, i) => {
      a.draw_position = i + 1;
    });
  }

  assignments.sort(
    (a, b) =>
      a.performance_number - b.performance_number || a.draw_position - b.draw_position,
  );

  return {
    ok: unplaced.length === 0,
    seed: request.seed,
    method: request.method,
    assignments,
    issues,
    unplaced,
  };
}

// ---------------------------------------------------------------------------
// Stock draw
// ---------------------------------------------------------------------------

export interface DrawableAnimal {
  animal_id: string;
  /** Only 'active' stock is drawn. */
  health_status: string;
  /** Contractor, so a producer can spread the work across contractors. */
  contractor_id?: string | null;
}

export interface StockDrawRequest {
  /** Entries needing an animal, already drawn into performances. */
  assignments: DrawAssignment[];
  animals: DrawableAnimal[];
  seed: string;
  go_round?: number;
  /**
   * Allow an animal to be used twice in the same go-round. Off by default —
   * an animal gets one out per round in every association's rules.
   */
  allow_reuse?: boolean;
}

export interface StockAssignment {
  entry_id: string;
  animal_id: string;
  go_round: number;
  performance_number: number;
}

export interface StockDrawResult {
  ok: boolean;
  seed: string;
  assignments: StockAssignment[];
  issues: ValidationIssue[];
  unmatched: string[];
}

/**
 * Draw stock to entries.
 *
 * Injured, retired and deceased animals are excluded — a draw that puts a
 * contestant on a lame horse is worse than no draw. One out per animal per
 * go-round unless the producer explicitly allows reuse.
 */
export function generateStockDraw(request: StockDrawRequest): StockDrawResult {
  const issues: ValidationIssue[] = [];
  const goRound = request.go_round ?? 1;
  const rng = makeRng(`${request.seed}:stock:round${goRound}`);

  const eligible = request.animals.filter((a) => a.health_status === 'active');
  const excluded = request.animals.length - eligible.length;
  if (excluded > 0) {
    issues.push({
      field: 'animals',
      code: 'STOCK_EXCLUDED',
      severity: 'warning',
      message: `${excluded} head excluded as not active (injured, retired or deceased).`,
    });
  }

  if (!request.allow_reuse && eligible.length < request.assignments.length) {
    issues.push({
      field: 'animals',
      code: 'INSUFFICIENT_STOCK',
      severity: 'error',
      message:
        `${request.assignments.length} entries but only ${eligible.length} head of ` +
        'active stock. Add stock or allow an animal to be used twice.',
    });
    return { ok: false, seed: request.seed, assignments: [], issues, unmatched: request.assignments.map((a) => a.entry_id) };
  }

  const pool = shuffle(
    [...eligible].sort((a, b) => a.animal_id.localeCompare(b.animal_id)),
    rng,
  );

  const ordered = [...request.assignments].sort(
    (a, b) =>
      a.performance_number - b.performance_number || a.draw_position - b.draw_position,
  );

  const assignments: StockAssignment[] = [];
  const unmatched: string[] = [];

  ordered.forEach((entry, i) => {
    const animal = request.allow_reuse ? pool[i % pool.length] : pool[i];
    if (!animal) {
      unmatched.push(entry.entry_id);
      return;
    }
    assignments.push({
      entry_id: entry.entry_id,
      animal_id: animal.animal_id,
      go_round: goRound,
      performance_number: entry.performance_number,
    });
  });

  return {
    ok: unmatched.length === 0 && !issues.some((i) => i.severity === 'error'),
    seed: request.seed,
    assignments,
    issues,
    unmatched,
  };
}

// ---------------------------------------------------------------------------
// Re-draw
// ---------------------------------------------------------------------------

/**
 * Replace one animal in a drawn round — a turnout, a reride, or stock that
 * came up sore between the draw and the performance.
 *
 * The replacement is picked from stock not already drawn in this round, so the
 * re-draw cannot hand somebody an animal that is already going. The original
 * assignment is returned alongside so the caller can record the link; a
 * re-draw is auditable, not a silent overwrite.
 */
export function redrawStock(input: {
  entry_id: string;
  current_animal_id: string;
  animals: DrawableAnimal[];
  already_drawn: string[];
  seed: string;
  reason: 'turnout' | 'reride' | 'animal_issue';
  go_round?: number;
}): { ok: boolean; animal_id: string | null; issues: ValidationIssue[] } {
  const goRound = input.go_round ?? 1;
  const taken = new Set([...input.already_drawn, input.current_animal_id]);

  const available = input.animals
    .filter((a) => a.health_status === 'active' && !taken.has(a.animal_id))
    .sort((a, b) => a.animal_id.localeCompare(b.animal_id));

  if (available.length === 0) {
    return {
      ok: false,
      animal_id: null,
      issues: [
        {
          field: 'animals',
          code: 'NO_REDRAW_STOCK',
          severity: 'error',
          message: 'No active stock left that is not already drawn in this round.',
        },
      ],
    };
  }

  // Seeded on the entry and reason so the same re-draw replays identically.
  const rng = makeRng(
    `${input.seed}:redraw:${input.entry_id}:${input.reason}:round${goRound}`,
  );
  const picked = available[Math.floor(rng() * available.length)];

  return { ok: true, animal_id: picked.animal_id, issues: [] };
}
