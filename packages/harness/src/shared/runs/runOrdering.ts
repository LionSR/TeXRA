/** Ordering helpers shared by stream tabs and transcript rows. */

/** Sort runs newest first, breaking ties alphabetically by id. */
export function compareByNewestCreationTime(
  a: { readonly id: string; readonly createdAt: number },
  b: { readonly id: string; readonly createdAt: number },
): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

/**
 * Compare transcript rows by their wire append sequence (`seqNo`), falling
 * back to a wall-clock key when either row predates sequence tracking.
 *
 * Live rows (both carrying a usable positive `seqNo`) sort by that sequence —
 * immune to clock skew and timestamp ties — with the fallback key as the
 * tie-break. Archived/compat rows, or a mix of row generations, keep the
 * caller's fallback chronology. `seqNoOf` and `fallbackTimeOf` let the same
 * rule serve message rows (`timestamp`) and group rows (`startTime`).
 */
export function compareBySeqNo<T>(
  a: T,
  b: T,
  seqNoOf: (item: T) => number | undefined,
  fallbackTimeOf: (item: T) => number,
): number {
  const aSeq = usableSequence(seqNoOf(a));
  const bSeq = usableSequence(seqNoOf(b));
  if (aSeq !== undefined && bSeq !== undefined) {
    return aSeq - bSeq || fallbackTimeOf(a) - fallbackTimeOf(b);
  }
  return fallbackTimeOf(a) - fallbackTimeOf(b);
}

/** A `seqNo` only orders rows when it is a positive safe integer. */
function usableSequence(seqNo: number | undefined): number | undefined {
  return seqNo !== undefined && Number.isSafeInteger(seqNo) && seqNo > 0
    ? seqNo
    : undefined;
}
