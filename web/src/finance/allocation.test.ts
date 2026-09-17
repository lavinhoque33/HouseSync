import { describe, expect, it } from 'vitest';
import {
  compareCanonicalUserIds,
  equalMinorUnitShares,
  isCanonicalUserUuid,
  previewEqualShares,
  sortCanonicalUserIds,
} from './allocation';

const A = '30000000-0000-4000-8000-000000000001';
const B = '30000000-0000-4000-8000-000000000002';
const C = '30000000-0000-4000-8000-000000000003';

describe('canonical user-UUID ordering', () => {
  it('accepts exactly the canonical lowercase hyphenated form', () => {
    expect(isCanonicalUserUuid(A)).toBe(true);
    expect(isCanonicalUserUuid('30000000-0000-4000-8000-00000000000g')).toBe(
      false,
    );
    expect(isCanonicalUserUuid('ABCDEF00-0000-4000-8000-000000000001')).toBe(
      false,
    );
    expect(isCanonicalUserUuid(A.slice(1))).toBe(false);
    expect(isCanonicalUserUuid('')).toBe(false);
  });

  it('sorts ascending by lowercase string order regardless of input case', () => {
    expect(compareCanonicalUserIds(C, B)).toBe(1);
    expect(compareCanonicalUserIds(B, C)).toBe(-1);
    expect(compareCanonicalUserIds(A, A)).toBe(0);
    expect(sortCanonicalUserIds([C, A, B])).toEqual([A, B, C]);
  });
});

describe('equal minor-unit division with the remainder rule', () => {
  it('splits USD 10.00 across three participants as 3.34, 3.33, 3.33', () => {
    // 1000 minor units: base 333 with one remainder minor unit going to
    // the first participant in ascending UUID order.
    expect(equalMinorUnitShares(1000n, 3)).toEqual([334n, 333n, 333n]);
  });

  it('splits JPY 1000 across three participants in whole units', () => {
    expect(equalMinorUnitShares(1000n, 3)).toEqual([334n, 333n, 333n]);
  });

  it('splits KWD 10.000 across three participants as 3.334, 3.333, 3.333', () => {
    expect(equalMinorUnitShares(10000n, 3)).toEqual([3334n, 3333n, 3333n]);
  });

  it('splits exactly when the division is even', () => {
    expect(equalMinorUnitShares(900n, 3)).toEqual([300n, 300n, 300n]);
  });

  it('awards every remainder minor unit in ascending order', () => {
    // USD 0.01 across two participants: one minor unit to the first.
    expect(equalMinorUnitShares(1n, 2)).toEqual([1n, 0n]);
    // USD 10.00 across seven: 1000 = 7 * 142 + 6, so six get 143.
    expect(equalMinorUnitShares(1000n, 7)).toEqual([
      143n,
      143n,
      143n,
      143n,
      143n,
      143n,
      142n,
    ]);
  });

  it('splits a single participant as the whole amount', () => {
    expect(equalMinorUnitShares(1000n, 1)).toEqual([1000n]);
  });

  it('rejects invalid counts and negative totals', () => {
    expect(() => equalMinorUnitShares(1000n, 0)).toThrow(RangeError);
    expect(() => equalMinorUnitShares(1000n, 1.5)).toThrow(RangeError);
    expect(() => equalMinorUnitShares(-1n, 3)).toThrow(RangeError);
  });
});

describe('exact share preview', () => {
  it('previews USD 10.00 across three members in canonical order', () => {
    expect(previewEqualShares('10.00', 'USD', [C, A, B])).toEqual([
      { userId: A, share: '3.34' },
      { userId: B, share: '3.33' },
      { userId: C, share: '3.33' },
    ]);
  });

  it('previews JPY 1000 across three members without decimal places', () => {
    expect(previewEqualShares('1000', 'JPY', [C, A, B])).toEqual([
      { userId: A, share: '334' },
      { userId: B, share: '333' },
      { userId: C, share: '333' },
    ]);
  });

  it('previews KWD 10.000 at scale 3', () => {
    expect(previewEqualShares('10.000', 'KWD', [C, A, B])).toEqual([
      { userId: A, share: '3.334' },
      { userId: B, share: '3.333' },
      { userId: C, share: '3.333' },
    ]);
  });

  it('splits 10.00 across two members as 5.00 and 5.00', () => {
    expect(previewEqualShares('10.00', 'USD', [B, A])).toEqual([
      { userId: A, share: '5.00' },
      { userId: B, share: '5.00' },
    ]);
  });

  it('previews a tiny amount with an exact zero share for the last participant', () => {
    // USD 0.01 across two members: one minor unit to the first in
    // canonical order and an exact zero share to the last, so the shares
    // still sum exactly to the magnitude.
    expect(previewEqualShares('0.01', 'USD', [B, A])).toEqual([
      { userId: A, share: '0.01' },
      { userId: B, share: '0.00' },
    ]);
    expect(previewEqualShares('0.001', 'KWD', [B, A, C])).toEqual([
      { userId: A, share: '0.001' },
      { userId: B, share: '0.000' },
      { userId: C, share: '0.000' },
    ]);
  });

  it('returns null for an empty selection', () => {
    expect(previewEqualShares('10.00', 'USD', [])).toBeNull();
  });

  it('returns null for duplicate or malformed participants', () => {
    expect(previewEqualShares('10.00', 'USD', [A, A])).toBeNull();
    expect(previewEqualShares('10.00', 'USD', [A, 'not-a-uuid'])).toBeNull();
  });
});
