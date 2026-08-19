// Host-neutral "how long has this child run" derivation over a roster row.
//
// The roster carries timestamps, never a rendered duration: `startedAt` opens
// the window and `finishedAt` closes it, so every surface answers elapsed time
// from the same two numbers and differs only in how it formats and how often
// it re-reads the clock. That is the whole point of this module — a formatted
// string on the wire would make the emitter's clock read and format the
// authority for readers that tick at their own rate.
//
// NO host imports here: a pure function over plain values.

import type { ActiveChildInfo } from '@shared/schemas';

/**
 * Elapsed run duration in ms for one roster row, or `undefined` when the row
 * carries no start stamp (legacy rows and hand-built fixtures). A retained
 * (finished) row measures to its `finishedAt` retention stamp so its reading
 * stops moving; a live row measures to `nowMs`.
 */
export function childElapsedMs(
  child: Pick<ActiveChildInfo, 'startedAt' | 'finishedAt'>,
  nowMs: number,
): number | undefined {
  const { startedAt, finishedAt } = child;
  if (startedAt === undefined) return undefined;
  return Math.max(0, (finishedAt ?? nowMs) - startedAt);
}
