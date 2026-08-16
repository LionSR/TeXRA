import type { StreamTabInfo } from '@shared/schemas';

/** Ordering helpers shared by stream tabs and transcript rows. */

/** The two fields tab order depends on, so name-only sorts can reuse this rule. */
type StreamOrderingFields = Pick<StreamTabInfo, 'name' | 'creationTimestamp'>;

/** Sort by newest creation time first, breaking ties alphabetically by name. */
export function compareByNewestCreationTime(
  a: StreamOrderingFields,
  b: StreamOrderingFields,
): number {
  return (
    b.creationTimestamp - a.creationTimestamp || a.name.localeCompare(b.name)
  );
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

function usableSequence(seqNo: number | undefined): number | undefined {
  return seqNo !== undefined && Number.isSafeInteger(seqNo) && seqNo > 0
    ? seqNo
    : undefined;
}
