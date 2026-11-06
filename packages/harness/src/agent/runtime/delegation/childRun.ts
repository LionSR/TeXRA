// Local imports
import { TraceEmitter } from '@agent/trace/TraceEmitter';
import type { RunId } from '@shared/schemas';
import type { SessionLogShape } from '@shared/session/sessionLog';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

/**
 * Normalize a child task's raw label to the ≤80-char description
 * `registerRun` writes as the run's one `run.description` row.
 */
export function childRunDescription(raw: string): string {
  return truncateWithEllipsis(raw, 80);
}

/** A process child's trace: the run's event publication, built with the
 *  session's log as its sink and closed with the run. */
export function createChildTrace(
  log: Pick<SessionLogShape, 'publish'>,
  runId: RunId,
): TraceEmitter {
  return new TraceEmitter((event) => log.publish(runId, event));
}
