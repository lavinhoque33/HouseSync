/** Canonical user UUID ordering for API allocation requests. */
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

/**
 * Sort participants into the canonical order the allocation API persists:
 * ascending canonical user UUID. Duplicates are preserved here because the
 * caller must reject them; every caller in this codebase does.
 */
export function sortCanonicalUserIds(ids: ReadonlyArray<string>): string[] {
  return [...ids].sort(compareCanonicalUserIds);
}
