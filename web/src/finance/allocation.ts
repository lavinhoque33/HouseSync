/**
 * Exact allocation arithmetic, following the documented contract
 * (docs/architecture/manual-finance-api.md, "Allocations and member
 * balances"). Shares are previewed with checked `bigint` minor units and
 * the documented remainder rule; no floating point, no `Number` arithmetic,
 * and no per-participant rounding ever touches a financial value.
 */

import {
  magnitudeOfMinorUnits,
  minorUnitsOfMagnitude,
  type FinancialAccountCurrency,
} from './money';

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Canonical user-UUID order: lowercase hyphenated string ordering. Returns
 * -1, 0, or 1 so it can feed `Array.prototype.sort` directly.
 */
export function compareCanonicalUserIds(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** A canonical (lowercase hyphenated) user UUID accepted by the API. */
export function isCanonicalUserUuid(value: string): boolean {
  return CANONICAL_UUID_PATTERN.test(value);
}

/**
 * Sort participants into the canonical order the allocation API persists:
 * ascending canonical user UUID. Duplicates are preserved here because the
 * caller must reject them; every caller in this codebase does.
 */
export function sortCanonicalUserIds(ids: ReadonlyArray<string>): string[] {
  return [...ids].sort(compareCanonicalUserIds);
}

/**
 * Equal division in minor units with the documented remainder rule: the
 * remainder minor units after equal division are awarded to participants
 * in ascending canonical user-UUID order (the caller supplies the total
 * already in that sorted order, so index order is UUID order). USD 10.00
 * across three participants is 1000 → 334, 333, 333.
 *
 * The count must be a positive integer and the total nonnegative;
 * violations throw rather than produce a silently wrong share set.
 */
export function equalMinorUnitShares(
  totalMinorUnits: bigint,
  participantCount: number,
): bigint[] {
  if (
    !Number.isInteger(participantCount) ||
    participantCount < 1 ||
    participantCount > 1_000_000
  ) {
    throw new RangeError('The participant count must be a positive integer.');
  }
  if (totalMinorUnits < 0n) {
    throw new RangeError('The split total must not be negative.');
  }
  const count = BigInt(participantCount);
  const base = totalMinorUnits / count;
  const remainder = totalMinorUnits % count;
  const shares: bigint[] = [];
  for (let index = 0; index < participantCount; index += 1) {
    shares.push(BigInt(index) < remainder ? base + 1n : base);
  }
  return shares;
}

export interface SharePreview {
  userId: string;
  share: string;
}

/**
 * The exact client-side share preview for one expense: the full positive
 * magnitude in its currency, divided equally across the selected
 * participants with the remainder rule applied in canonical UUID order.
 * Shares are returned in that same canonical order, each an exact
 * currency-scale string; the shares always sum exactly to the magnitude.
 *
 * Every participant ID must be a distinct canonical UUID and the magnitude
 * must be an unsigned scale-exact amount string; violations return null so
 * the caller rejects the draft instead of previewing invented numbers.
 */
export function previewEqualShares(
  magnitude: string,
  currency: FinancialAccountCurrency,
  participantUserIds: ReadonlyArray<string>,
): SharePreview[] | null {
  if (participantUserIds.length === 0) return null;
  const sorted = sortCanonicalUserIds(participantUserIds);
  for (const id of sorted) {
    if (!isCanonicalUserUuid(id)) return null;
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) return null;
  }
  const total = minorUnitsOfMagnitude(magnitude, currency);
  const shares = equalMinorUnitShares(total, sorted.length);
  const result: SharePreview[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const userId = sorted[index];
    const share = shares[index];
    if (userId === undefined || share === undefined) return null;
    result.push({ userId, share: magnitudeOfMinorUnits(share, currency) });
  }
  return result;
}
