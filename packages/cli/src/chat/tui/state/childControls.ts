/**
 * Focus-order rules over the session view (PRD one-fold-three-renderers,
 * 9): which stream the child list roots at, which stream Alt+N names, and
 * how a stream is presented. Surface decisions over fold facts; nothing
 * here derives topology.
 */
import { RUN_PHASE, type RunPhase, type RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import { childElapsedMs } from '@shared/runs/childElapsed';
import { formatCompactDuration } from '@utils/core';
import { focusRun, openWorkflowPopup } from './cliState';
import { currentView, runViewOf } from './sessionView';

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
  const elapsedMs = childElapsedMs(child, nowMs);
  return elapsedMs === undefined ? undefined : formatCompactDuration(elapsedMs);
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

export function isWorkflowScriptRun(view: SessionView, runId: RunId): boolean {
  return runViewOf(view, runId)?.identity?.kind === 'multiAgentWorkflow';
}

/**
 * A workflow-script run is presented through its popup over its parent;
 * every other stream becomes the active conversation.
 */
export function presentRun(runId: RunId): 'run' | 'workflowPopup' {
  const view = currentView();
  if (isWorkflowScriptRun(view, runId)) {
    const parentId = runViewOf(view, runId)?.parentId;
    if (parentId) focusRun(parentId);
    openWorkflowPopup(runId);
    return 'workflowPopup';
  }
  focusRun(runId);
  return 'run';
}
