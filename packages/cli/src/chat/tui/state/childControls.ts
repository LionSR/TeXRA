// Pure state helpers for App-level child execution navigation.

// Local imports - shared schemas
import {
  STREAM_PHASE,
  type ActiveChildInfo,
  type StreamTabId,
} from '@shared/schemas';
import { childElapsedMs } from '@shared/streams/childElapsed';
import { formatCompactDuration } from '@utils/core';

// Local imports - CLI state
import {
  nearestActiveStreamAncestor,
  streamIdentityFor,
  streamTreeEntries,
} from './streamViews';
import {
  childRosters,
  parentStream,
  visibleSubagentRows,
  type ChildRosters,
} from './childExecutions';
import { focusStream, openWorkflowPopup, type StreamSlice } from './cliState';

/** Compact elapsed reading for one child row, shown only while it is running:
 *  a settled row's duration is reported by the task card that owns its
 *  outcome, so repeating a frozen figure in the live list is noise. */
export function childElapsed(
  child: Pick<ActiveChildInfo, 'startedAt' | 'finishedAt' | 'status'>,
  nowMs = Date.now(),
): string | undefined {
  if (child.status !== undefined && child.status !== STREAM_PHASE.RUNNING) {
    return undefined;
  }
  const elapsedMs = childElapsedMs(child, nowMs);
  return elapsedMs === undefined ? undefined : formatCompactDuration(elapsedMs);
}

function hasChildListItems(
  parentStreamId: StreamTabId | undefined,
  childRosters: ChildRosters,
): boolean {
  if (parentStreamId === undefined) return false;
  return visibleSubagentRows(parentStreamId, childRosters).length > 0;
}

/** Resolve the nearest stream whose child sessions populate the persistent
 * child list. */
export function resolveChildListTarget({
  activeStreamId,
  childRosters,
  parentStream,
  streams,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childRosters: ChildRosters;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): StreamTabId | undefined {
  if (activeStreamId && !hasChildListItems(activeStreamId, childRosters)) {
    const ancestor = nearestActiveStreamAncestor({
      activeStreamId,
      parentStream,
      values: streams,
      canUseValue: (_slice, streamId) =>
        hasChildListItems(streamId, childRosters),
    });
    if (ancestor) return ancestor.streamId;
  }

  return activeStreamId;
}

export function numericFocusTargetForActiveStream(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childRosters: ChildRosters;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly zeroBasedIndex: number;
}): StreamTabId | undefined {
  if (!init.activeStreamId || init.zeroBasedIndex < 0) return undefined;
  const shortcutIndex = init.zeroBasedIndex + 1;
  return streamTreeEntries({
    activeStreamId: init.activeStreamId,
    childRosters: init.childRosters,
    parentStream: init.parentStream,
    rootStreamId: resolveChildListTarget(init),
    streams: init.streams,
  }).find((entry) => entry.shortcutIndex === shortcutIndex)?.id;
}

/** The parent that lists a child on its roster, for the interval before the
 *  parent edge is recorded (roster-first event ordering). */
function rosterParentOf(streamId: StreamTabId): StreamTabId | undefined {
  for (const [parentId, rows] of childRosters.get()) {
    if (rows.some((row) => row.childStreamId === streamId)) return parentId;
  }
  return undefined;
}

/** Whether a stream is a workflow-script run. */
export function isWorkflowScriptStream(streamId: StreamTabId): boolean {
  return (
    streamIdentityFor({
      childRosters: childRosters.get(),
      parentStream: parentStream.get(),
      streamId,
    })?.kind === 'multiAgentWorkflow'
  );
}

/**
 * Show a stream the way the user expects to see it. A workflow-script run is
 * never a viewport: presenting one lands on its parent with the popup open
 * over it. Every writer of `activeStreamId` that means "show me this stream"
 * — the session list, Alt-N, Esc out of a child, an approval announcing its
 * stream, the return to a finished child's owner — goes through here, so the
 * rule has one owner.
 */
export function presentStream(
  streamId: StreamTabId,
): 'stream' | 'workflowPopup' {
  if (isWorkflowScriptStream(streamId)) {
    const parentId =
      parentStream.get().get(streamId) ?? rosterParentOf(streamId);
    if (parentId !== undefined) focusStream(parentId);
    openWorkflowPopup(streamId);
    return 'workflowPopup';
  }
  focusStream(streamId);
  return 'stream';
}
