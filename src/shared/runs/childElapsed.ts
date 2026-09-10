// Host-neutral elapsed derivation over a selected child time window.
//
// Callers select the window before invoking this helper: live rows project the
// status plane's active-phase `runStartedAt` into the start slot, while retained
// rows use the roster's handle-generation `startedAt` and `finishedAt`. The
// helper keeps only the arithmetic shared; each surface owns its formatting and
// tick rate instead of receiving a rendered duration on the wire.
//
// NO host imports here: a pure function over plain values.

import type { ActiveChildInfo } from '@shared/schemas';

/**
 * Elapsed duration in ms for the caller-selected child window, or `undefined`
 * when it carries no start stamp. A closed window measures to `finishedAt` so
 * its reading stops moving; an open window measures to `nowMs`.
 */
export function childElapsedMs(
  child: Pick<ActiveChildInfo, 'startedAt' | 'finishedAt'>,
  nowMs: number,
): number | undefined {
  const { startedAt, finishedAt } = child;
  if (startedAt === undefined) return undefined;
  return Math.max(0, (finishedAt ?? nowMs) - startedAt);
}
