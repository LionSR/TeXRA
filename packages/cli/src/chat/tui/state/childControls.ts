/**
 * Focus-order rules over the session view: which stream the child list roots at, which stream Alt+N names, and
 * how a stream is presented. Surface decisions over session view facts; nothing
 * here derives topology.
 */
import { formatCompactDuration } from '@texra-ai/harness/transcript';
import { type RunId } from '@texra-ai/harness/schemas';
import { runViewOf } from './sessionView';
import type { SessionView } from '@texra-ai/harness/schemas';

/**
 * How long a running child has been at it, formatted: the caller selects the
 * window (the session view's `runStartedAt`, set only while the run works), and a
 * child that is not working shows none.
 */
export function childElapsed(
  startedAt: number | undefined,
  nowMs: number,
): string | undefined {
  if (startedAt === undefined) return undefined;
  return formatCompactDuration(Math.max(0, nowMs - startedAt));
}

function hasChildren(view: SessionView, runId: RunId): boolean {
  return (runViewOf(view, runId)?.childIds.length ?? 0) > 0;
}

/**
 * The stream whose children the list shows: the active stream when it has
 * any, else its nearest ancestor that has, else the active stream itself.
 */
export function resolveChildListTarget(
  view: SessionView,
  activeRunId: RunId | undefined,
): RunId | undefined {
  if (activeRunId === undefined || hasChildren(view, activeRunId)) {
    return activeRunId;
  }
  const ancestors = runViewOf(view, activeRunId)?.ancestors ?? [];
  // Root first in the view; the nearest ancestor with children wins.
  for (const ancestor of ancestors.toReversed()) {
    if (hasChildren(view, ancestor.id)) return ancestor.id;
  }
  return activeRunId;
}
