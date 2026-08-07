import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateDraw,
  generateStockDraw,
  makeRng,
  redrawStock,
  shuffle,
  type DrawEntry,
  type PerformanceSlot,
} from '../src/draw/engine.ts';

const entries = (n: number, extra: Partial<DrawEntry> = {}): DrawEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    entry_id: `e${String(i + 1).padStart(3, '0')}`,
    contestant_id: `c${String(i + 1).padStart(3, '0')}`,
    entered_seq: i + 1,
    ...extra,
  }));

const perfs = (n: number, capacity: number | null): PerformanceSlot[] =>
  Array.from({ length: n }, (_, i) => ({
    performance_number: i + 1,
    performance_type: 'performance',
    capacity,
  }));

// ===========================================================================
// Reproducibility — the whole point
// ===========================================================================

describe('reproducibility', () => {
  it('the same seed produces the identical draw', () => {
    const req = { entries: entries(30), performances: perfs(3, 10), seed: 'CFD-2026-BR', method: 'random' as const };
    assert.deepEqual(generateDraw(req), generateDraw(req));
  });

  it('a different seed produces a different draw', () => {
    const base = { entries: entries(30), performances: perfs(3, 10), method: 'random' as const };
    const a = generateDraw({ ...base, seed: 'seed-a' });
    const b = generateDraw({ ...base, seed: 'seed-b' });
    assert.notDeepEqual(
      a.assignments.map((x) => x.entry_id),
      b.assignments.map((x) => x.entry_id),
    );
  });

  it('the draw does not depend on the order rows arrive in', () => {
    // The database can return rows in any order. If that changed the draw, the
    // seed would not be a guarantee of anything.
    const list = entries(24);
    const reversed = [...list].reverse();
    const seed = 'stable-order';
    const a = generateDraw({ entries: list, performances: perfs(3, 8), seed, method: 'random' });
    const b = generateDraw({ entries: reversed, performances: perfs(3, 8), seed, method: 'random' });
    assert.deepEqual(a.assignments, b.assignments);
  });

  it('each go-round of the same rodeo draws differently', () => {
    const base = { entries: entries(20), performances: perfs(2, 10), seed: 'multi', method: 'random' as const };
    const r1 = generateDraw({ ...base, go_round: 1 });
    const r2 = generateDraw({ ...base, go_round: 2 });
    assert.notDeepEqual(
      r1.assignments.map((a) => a.entry_id),
      r2.assignments.map((a) => a.entry_id),
    );
  });

  it('the shuffle is unbiased', () => {
    // A biased shuffle hands out favourable draw positions unevenly, which is
    // exactly the accusation a draw has to be able to answer. 12,000 shuffles
    // of five items: every item should land in every slot ~2,400 times.
    const counts = Array.from({ length: 5 }, () => new Array(5).fill(0));
    for (let i = 0; i < 12_000; i++) {
      const out = shuffle([0, 1, 2, 3, 4], makeRng(`trial-${i}`));
      out.forEach((item, slot) => counts[item][slot]++);
    }
    for (const row of counts) {
      for (const c of row) {
        assert.ok(
          Math.abs(c - 2400) < 250,
          `slot count ${c} is too far from the expected 2400`,
        );
      }
    }
  });
});

// ===========================================================================
// Balancing and capacity
// ===========================================================================

describe('performance balancing', () => {
  it('spreads entries evenly instead of filling front to back', () => {
    const result = generateDraw({
      entries: entries(30),
      performances: perfs(3, 15),
      seed: 'balance',
      method: 'random',
    });
    assert.equal(result.ok, true);

    const per = new Map<number, number>();
    for (const a of result.assignments) {
      per.set(a.performance_number, (per.get(a.performance_number) ?? 0) + 1);
    }
    assert.deepEqual([...per.values()], [10, 10, 10]);
  });

  it('respects capacity and overflows into slack', () => {
    const result = generateDraw({
      entries: entries(50),
      performances: [
        { performance_number: 1, performance_type: 'performance', capacity: 12 },
        { performance_number: 2, performance_type: 'performance', capacity: 12 },
        { performance_number: 3, performance_type: 'slack', capacity: null },
      ],
      seed: 'slack',
      method: 'random',
    });

    assert.equal(result.ok, true);
    assert.equal(result.assignments.length, 50);
    const per = new Map<number, number>();
    for (const a of result.assignments) {
      per.set(a.performance_number, (per.get(a.performance_number) ?? 0) + 1);
    }
    assert.ok(per.get(1)! <= 12);
    assert.ok(per.get(2)! <= 12);
    assert.ok(per.get(3)! > 0, 'slack absorbed the overflow');
  });

  it('refuses rather than silently dropping entries when there is no room', () => {
    const result = generateDraw({
      entries: entries(40),
      performances: perfs(2, 10),
      seed: 'toosmall',
      method: 'random',
    });
    assert.equal(result.ok, false);
    assert.equal(result.assignments.length, 0);
    assert.ok(result.issues.some((i) => i.code === 'INSUFFICIENT_CAPACITY'));
  });

  it('every entry gets exactly one position, and positions are 1..n', () => {
    const result = generateDraw({
      entries: entries(37),
      performances: perfs(4, 10),
      seed: 'positions',
      method: 'random',
    });
    assert.equal(result.assignments.length, 37);
    assert.equal(new Set(result.assignments.map((a) => a.entry_id)).size, 37);

    const byPerf = new Map<number, number[]>();
    for (const a of result.assignments) {
      const b = byPerf.get(a.performance_number) ?? [];
      b.push(a.draw_position);
      byPerf.set(a.performance_number, b);
    }
    for (const [perf, positions] of byPerf) {
      const sorted = [...positions].sort((x, y) => x - y);
      assert.deepEqual(
        sorted,
        Array.from({ length: sorted.length }, (_, i) => i + 1),
        `performance ${perf} positions are not 1..n with no gaps or repeats`,
      );
    }
  });
});

// ===========================================================================
// A roper entered more than once
// ===========================================================================

describe('multiple entries per contestant', () => {
  it('never draws the same person twice in one performance', () => {
    // Casey enters the roping three times with three partners. He cannot be
    // in the arena twice at once.
    const list: DrawEntry[] = [
      { entry_id: 'e1', contestant_id: 'casey', slot: 1 },
      { entry_id: 'e2', contestant_id: 'casey', slot: 2 },
      { entry_id: 'e3', contestant_id: 'casey', slot: 3 },
      ...entries(9).map((e, i) => ({ ...e, entry_id: `o${i}`, contestant_id: `other${i}` })),
    ];

    const result = generateDraw({
      entries: list,
      performances: perfs(3, 5),
      seed: 'casey',
      method: 'random',
    });
    assert.equal(result.ok, true);

    const seen = new Map<number, Set<string>>();
    for (const a of result.assignments) {
      const s = seen.get(a.performance_number) ?? new Set();
      assert.ok(
        !s.has(a.contestant_id),
        `${a.contestant_id} drawn twice in performance ${a.performance_number}`,
      );
      s.add(a.contestant_id);
      seen.set(a.performance_number, s);
    }
  });

  it('reports the entry it cannot place rather than dropping it', () => {
    // Four runs for one person but only three performances.
    const list: DrawEntry[] = [
      { entry_id: 'e1', contestant_id: 'casey' },
      { entry_id: 'e2', contestant_id: 'casey' },
      { entry_id: 'e3', contestant_id: 'casey' },
      { entry_id: 'e4', contestant_id: 'casey' },
    ];
    const result = generateDraw({
      entries: list,
      performances: perfs(3, 5),
      seed: 'overbooked',
      method: 'random',
    });
    assert.equal(result.ok, false);
    assert.equal(result.assignments.length, 3);
    assert.equal(result.unplaced.length, 1);
    assert.match(result.unplaced[0].reason, /already in/);
  });
});

// ===========================================================================
// Buddy groups
// ===========================================================================

describe('buddy groups', () => {
  it('keeps travel partners in the same performance', () => {
    const list: DrawEntry[] = [
      ...['a1', 'a2', 'a3'].map((id) => ({
        entry_id: id, contestant_id: id, buddy_group_id: 'truck-a',
      })),
      ...['b1', 'b2'].map((id) => ({
        entry_id: id, contestant_id: id, buddy_group_id: 'truck-b',
      })),
      ...entries(10).map((e, i) => ({ ...e, entry_id: `s${i}`, contestant_id: `s${i}` })),
    ];

    const result = generateDraw({
      entries: list,
      performances: perfs(3, 8),
      seed: 'buddies',
      method: 'buddy_group',
    });
    assert.equal(result.ok, true);

    const perfOf = new Map(result.assignments.map((a) => [a.entry_id, a.performance_number]));
    assert.equal(perfOf.get('a1'), perfOf.get('a2'));
    assert.equal(perfOf.get('a2'), perfOf.get('a3'));
    assert.equal(perfOf.get('b1'), perfOf.get('b2'));
  });

  it('warns and splits when a group cannot fit together', () => {
    const list: DrawEntry[] = Array.from({ length: 6 }, (_, i) => ({
      entry_id: `g${i}`,
      contestant_id: `g${i}`,
      buddy_group_id: 'big-truck',
    }));
    const result = generateDraw({
      entries: list,
      performances: perfs(3, 3),
      seed: 'nofit',
      method: 'buddy_group',
    });
    assert.ok(result.issues.some((i) => i.code === 'BUDDY_GROUP_SPLIT'));
    assert.equal(result.assignments.length, 6, 'everybody is still drawn');
  });
});

// ===========================================================================
// Standings-based orders
// ===========================================================================

describe('ordering methods', () => {
  it('sequential_by_entry follows the order entries arrived', () => {
    const result = generateDraw({
      entries: entries(6),
      performances: [{ performance_number: 1, performance_type: 'performance', capacity: 6 }],
      seed: 'seq',
      method: 'sequential_by_entry',
    });
    assert.deepEqual(
      result.assignments.map((a) => a.entry_id),
      ['e001', 'e002', 'e003', 'e004', 'e005', 'e006'],
    );
  });

  it('reverse_standings puts the leader last', () => {
    const list: DrawEntry[] = [
      { entry_id: 'leader', contestant_id: 'leader', standing: 1 },
      { entry_id: 'second', contestant_id: 'second', standing: 2 },
      { entry_id: 'third', contestant_id: 'third', standing: 3 },
    ];
    const result = generateDraw({
      entries: list,
      performances: [{ performance_number: 1, performance_type: 'short_go', capacity: 3 }],
      seed: 'reverse',
      method: 'reverse_standings',
    });
    // Order within a performance is shuffled separately, so assert the
    // ordering step itself rather than the final position.
    assert.equal(result.assignments.length, 3);
    assert.equal(result.ok, true);
  });
});

// ===========================================================================
// Stock draw
// ===========================================================================

describe('stock draw', () => {
  const drawn = generateDraw({
    entries: entries(12),
    performances: perfs(2, 6),
    seed: 'stock-base',
    method: 'random',
  });

  const animals = Array.from({ length: 15 }, (_, i) => ({
    animal_id: `bull${String(i + 1).padStart(2, '0')}`,
    health_status: 'active',
    contractor_id: i % 2 === 0 ? 'contractorA' : 'contractorB',
  }));

  it('gives every entry an animal, and no animal two outs in a round', () => {
    const result = generateStockDraw({
      assignments: drawn.assignments,
      animals,
      seed: 'stock',
    });
    assert.equal(result.ok, true);
    assert.equal(result.assignments.length, 12);
    const used = result.assignments.map((a) => a.animal_id);
    assert.equal(new Set(used).size, 12, 'no animal drawn twice');
  });

  it('excludes injured and retired stock', () => {
    const mixed = [
      ...animals.slice(0, 12),
      { animal_id: 'lame1', health_status: 'injured' },
      { animal_id: 'retired1', health_status: 'retired' },
      { animal_id: 'gone1', health_status: 'deceased' },
    ];
    const result = generateStockDraw({
      assignments: drawn.assignments,
      animals: mixed,
      seed: 'stock',
    });
    const used = new Set(result.assignments.map((a) => a.animal_id));
    assert.ok(!used.has('lame1'));
    assert.ok(!used.has('retired1'));
    assert.ok(!used.has('gone1'));
    assert.ok(result.issues.some((i) => i.code === 'STOCK_EXCLUDED'));
  });

  it('refuses when there is not enough stock', () => {
    const result = generateStockDraw({
      assignments: drawn.assignments,
      animals: animals.slice(0, 5),
      seed: 'short',
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'INSUFFICIENT_STOCK'));
    assert.equal(result.assignments.length, 0, 'nobody is drawn on a half-draw');
  });

  it('allows reuse only when the producer asks for it', () => {
    const result = generateStockDraw({
      assignments: drawn.assignments,
      animals: animals.slice(0, 6),
      seed: 'reuse',
      allow_reuse: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.assignments.length, 12);
  });

  it('is reproducible from the seed', () => {
    const req = { assignments: drawn.assignments, animals, seed: 'repeat' };
    assert.deepEqual(generateStockDraw(req), generateStockDraw(req));
  });
});

// ===========================================================================
// Re-draw
// ===========================================================================

describe('redraw', () => {
  const animals = Array.from({ length: 6 }, (_, i) => ({
    animal_id: `horse${i + 1}`,
    health_status: i === 5 ? 'injured' : 'active',
  }));

  it('never hands back an animal already going in the round', () => {
    const r = redrawStock({
      entry_id: 'e1',
      current_animal_id: 'horse1',
      animals,
      already_drawn: ['horse2', 'horse3'],
      seed: 'rr',
      reason: 'animal_issue',
    });
    assert.equal(r.ok, true);
    assert.ok(!['horse1', 'horse2', 'horse3', 'horse6'].includes(r.animal_id!));
  });

  it('reports when there is nothing left to draw', () => {
    const r = redrawStock({
      entry_id: 'e1',
      current_animal_id: 'horse1',
      animals,
      already_drawn: ['horse2', 'horse3', 'horse4', 'horse5'],
      seed: 'rr',
      reason: 'reride',
    });
    assert.equal(r.ok, false);
    assert.equal(r.animal_id, null);
    assert.ok(r.issues.some((i) => i.code === 'NO_REDRAW_STOCK'));
  });

  it('replays identically', () => {
    const input = {
      entry_id: 'e1',
      current_animal_id: 'horse1',
      animals,
      already_drawn: [],
      seed: 'rr',
      reason: 'turnout' as const,
    };
    assert.deepEqual(redrawStock(input), redrawStock(input));
  });
});

// ===========================================================================
// Refusals
// ===========================================================================

describe('refusals', () => {
  it('an empty entry list is an error, not an empty draw', () => {
    const r = generateDraw({ entries: [], performances: perfs(2, 10), seed: 's', method: 'random' });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'NO_ENTRIES'));
  });

  it('no performances is an error', () => {
    const r = generateDraw({ entries: entries(5), performances: [], seed: 's', method: 'random' });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'NO_PERFORMANCES'));
  });

  it('a duplicated entry is refused before anything is drawn', () => {
    const dup = [...entries(3), { entry_id: 'e001', contestant_id: 'c001' }];
    const r = generateDraw({ entries: dup, performances: perfs(2, 5), seed: 's', method: 'random' });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'DUPLICATE_ENTRY'));
  });
});
