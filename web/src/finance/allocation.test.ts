import { describe, expect, it } from 'vitest';
import { compareCanonicalUserIds, sortCanonicalUserIds } from './allocation';

const A = '30000000-0000-4000-8000-000000000001';
const B = '30000000-0000-4000-8000-000000000002';
const C = '30000000-0000-4000-8000-000000000003';

describe('canonical user-UUID ordering', () => {
  it('sorts ascending by lowercase string order regardless of input case', () => {
    expect(compareCanonicalUserIds(C, B)).toBe(1);
    expect(compareCanonicalUserIds(B, C)).toBe(-1);
    expect(compareCanonicalUserIds(A, A)).toBe(0);
    expect(sortCanonicalUserIds([C, A, B])).toEqual([A, B, C]);
  });
});
