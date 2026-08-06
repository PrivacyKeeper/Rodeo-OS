import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { allocate, pctOfCents, splitEvenly, toCents } from '../src/money.ts';

describe('allocate', () => {
  it('always sums to exactly the input', () => {
    const cases: [number, number[]][] = [
      [10000, [0.5, 0.3, 0.2]],
      [10001, [0.5, 0.3, 0.2]],
      [10, [1, 1, 1]],
      [1, [1, 1, 1, 1, 1]],
      [99999, [0.4, 0.3, 0.2, 0.1]],
      [333, [1, 1, 1]],
      [7, [0.35, 0.25, 0.18, 0.13, 0.09]],
    ];

    for (const [total, weights] of cases) {
      const parts = allocate(total, weights);
      const sum = parts.reduce((s, v) => s + v, 0);
      assert.equal(sum, total, `allocate(${total}, ${weights}) summed to ${sum}`);
      assert.ok(parts.every(Number.isInteger), 'all parts are whole cents');
      assert.ok(parts.every((p) => p >= 0), 'no negative parts');
    }
  });

  it('distributes leftover cents to the largest remainders first', () => {
    // $100.00 split three ways: 3334 / 3333 / 3333.
    assert.deepEqual(splitEvenly(10000, 3), [3334, 3333, 3333]);
  });

  it('is deterministic, so a re-run pays the same people the same amounts', () => {
    const a = allocate(123457, [0.4, 0.3, 0.2, 0.1]);
    const b = allocate(123457, [0.4, 0.3, 0.2, 0.1]);
    assert.deepEqual(a, b);
  });

  it('gives zero-weight entries nothing', () => {
    const parts = allocate(10000, [0.5, 0.5, 0, 0]);
    assert.deepEqual(parts, [5000, 5000, 0, 0]);
  });

  it('returns zeros for a zero or negative purse', () => {
    assert.deepEqual(allocate(0, [0.5, 0.5]), [0, 0]);
    assert.deepEqual(allocate(-500, [0.5, 0.5]), [0, 0]);
  });

  it('handles weights that do not sum to one', () => {
    const parts = allocate(9000, [2, 2, 3]);
    assert.equal(parts.reduce((s, v) => s + v, 0), 9000);
    assert.deepEqual(parts, [2572, 2571, 3857]);
  });

  it('never drops a cent across a thousand awkward purses', () => {
    for (let total = 1; total <= 1000; total++) {
      for (const weights of [
        [0.5, 0.3, 0.2],
        [0.35, 0.25, 0.18, 0.13, 0.09],
        [1, 1, 1, 1, 1, 1, 1],
      ]) {
        const parts = allocate(total, weights);
        assert.equal(
          parts.reduce((s, v) => s + v, 0),
          total,
          `lost a cent at total=${total}`,
        );
      }
    }
  });
});

describe('toCents', () => {
  it('survives the classic float traps', () => {
    assert.equal(toCents(0.1 + 0.2), 30);
    assert.equal(toCents(1.005), 100); // 1.005 is really 1.00499999... in binary
    assert.equal(toCents(19.99), 1999);
    assert.equal(toCents(1234.56), 123456);
  });
});

describe('pctOfCents', () => {
  it('rounds to a whole cent', () => {
    assert.equal(pctOfCents(10000, 0.06), 600);
    assert.equal(pctOfCents(3333, 0.06), 200);
    assert.equal(pctOfCents(1, 0.5), 1); // round-half-up
  });
});
