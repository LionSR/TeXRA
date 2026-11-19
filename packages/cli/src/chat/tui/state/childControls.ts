/** How a child run's elapsed time reads in the terminal's child list. */
import { formatCompactDuration } from '@texra-ai/harness/schemas';

/**
 * How long a running child has been at it, formatted: the caller selects the
 * window (the session view's `runStartedAt`, set only while the run is busy on a
 * turn), and a child that is not shows none.
 */
export function childElapsed(
  startedAt: number | undefined,
  nowMs: number,
): string | undefined {
  if (startedAt === undefined) return undefined;
  return formatCompactDuration(Math.max(0, nowMs - startedAt));
}
