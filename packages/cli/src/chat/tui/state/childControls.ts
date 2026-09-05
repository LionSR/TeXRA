/**
 * Focus-order rules over the session view (PRD one-fold-three-renderers,
 * 9): which stream the child list roots at, which stream Alt+N names, and
 * how a stream is presented. Surface decisions over fold facts; nothing
 * here derives topology.
 */
import {
  STREAM_PHASE,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import { childElapsedMs } from '@shared/streams/childElapsed';
import { formatCompactDuration } from '@utils/core';
import { focusStream, openWorkflowPopup } from './cliState';
import { currentView, focusTreeOf, streamViewOf } from './sessionView';

export function childElapsed(
  child: {
    readonly status: StreamPhase | undefined;
    readonly startedAt: number | undefined;
  },
  nowMs = Date.now(),
): string | undefined {
  if (child.status !== undefined && child.status !== STREAM_PHASE.RUNNING) {
    return undefined;
  }
  const elapsedMs = childElapsedMs(child, nowMs);
  return elapsedMs === undefined ? undefined : formatCompactDuration(elapsedMs);
}

function hasChildren(view: SessionView, streamId: StreamTabId): boolean {
  return (streamViewOf(view, streamId)?.childIds.length ?? 0) > 0;
}

/**
 * The stream whose children the list shows: the active stream when it has
 * any, else its nearest ancestor that has, else the active stream itself.
 */
export function resolveChildListTarget(
  view: SessionView,
  activeStreamId: StreamTabId | undefined,
): StreamTabId | undefined {
  if (activeStreamId === undefined || hasChildren(view, activeStreamId)) {
    return activeStreamId;
  }
  const ancestors = streamViewOf(view, activeStreamId)?.ancestors ?? [];
  // Root first in the view; the nearest ancestor with children wins.
  for (const ancestor of ancestors.toReversed()) {
    if (hasChildren(view, ancestor.id)) return ancestor.id;
  }
  return activeStreamId;
}

/** Alt+1..9: the Nth entry after the list root in the focus tree. */
export function numericFocusTargetForActiveStream(
  view: SessionView,
  activeStreamId: StreamTabId | undefined,
  zeroBasedIndex: number,
): StreamTabId | undefined {
  if (activeStreamId === undefined || zeroBasedIndex < 0) return undefined;
  if (zeroBasedIndex >= 9) return undefined;
  const tree = focusTreeOf(view, resolveChildListTarget(view, activeStreamId));
  return tree[zeroBasedIndex + 1];
}

export function isWorkflowScriptStream(
  view: SessionView,
  streamId: StreamTabId,
): boolean {
  return streamViewOf(view, streamId)?.identity?.kind === 'multiAgentWorkflow';
}

/**
 * A workflow-script run is presented through its popup over its parent;
 * every other stream becomes the active conversation.
 */
export function presentStream(
  streamId: StreamTabId,
): 'stream' | 'workflowPopup' {
  const view = currentView();
  if (isWorkflowScriptStream(view, streamId)) {
    const parentId = streamViewOf(view, streamId)?.parentId;
    if (parentId) focusStream(parentId);
    openWorkflowPopup(streamId);
    return 'workflowPopup';
  }
  focusStream(streamId);
  return 'stream';
}
