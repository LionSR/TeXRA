/**
 * Focus-order rules over the session view (PRD one-fold-three-renderers,
 * 9): which stream the child list roots at, which stream Alt+N names, and
 * how a stream is presented. Surface decisions over fold facts; nothing
 * here derives topology.
 */
import { formatCompactDuration } from '@texra-ai/harness/transcript';
import {
  RUN_PHASE,
  type RunPhase,
  type RunId,
} from '@texra-ai/harness/schemas';
import { runViewOf } from './sessionView';
import type { RunView, SessionView } from '@texra-ai/harness/schemas';

/**
 * When a run's active time started, or nothing: a run parked on the user's
 * answer is not working, so no clock or spinner runs for it.
 */
export function activeStartedAt(
  run: Pick<RunView, 'group' | 'runStartedAt'> | undefined,
): number | undefined {
  if (run === undefined || run.group === 'waiting') return undefined;
  return run.runStartedAt ?? undefined;
}

/**
 * How long a running child has been at it, formatted: the caller selects the
 * window (the fold's active-phase `runStartedAt`), and a child that is not
 * running shows none.
 */
export function childElapsed(
  child: {
    readonly status: RunPhase | undefined;
    readonly startedAt: number | undefined;
  },
  nowMs = Date.now(),
): string | undefined {
  if (child.status !== undefined && child.status !== RUN_PHASE.RUNNING) {
    return undefined;
  }
  if (child.startedAt === undefined) return undefined;
  return formatCompactDuration(Math.max(0, nowMs - child.startedAt));
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
