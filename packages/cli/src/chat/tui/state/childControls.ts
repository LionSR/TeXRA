// Pure state helpers for App-level child execution navigation.

// Local imports - shared schemas
import {
  STREAM_PHASE,
  type ActiveChildInfo,
  type StreamTabId,
} from '@shared/schemas';
import { formatCompactDuration } from '@utils/core';

// Local imports - CLI state
import { nearestActiveStreamAncestor, streamTreeEntries } from './streamViews';
import { visibleSubagentRows, type ChildRosters } from './childExecutions';
import type { StreamSlice } from './cliState';

export interface ChildListTarget {
  readonly slice: StreamSlice | undefined;
  readonly streamId: StreamTabId | undefined;
}

export function childElapsed(
  child: Pick<ActiveChildInfo, 'elapsed' | 'startedAt' | 'status'>,
  nowMs = Date.now(),
): string | null | undefined {
  const { startedAt, status } = child;
  if (startedAt === undefined) return child.elapsed;
  if (status !== undefined && status !== STREAM_PHASE.RUNNING) {
    return child.elapsed;
  }
  return formatCompactDuration(nowMs - startedAt);
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
}): ChildListTarget {
  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  if (activeStreamId && !hasChildListItems(activeStreamId, childRosters)) {
    const ancestor = nearestActiveStreamAncestor({
      activeStreamId,
      parentStream,
      values: streams,
      canUseValue: (_slice, streamId) =>
        hasChildListItems(streamId, childRosters),
    });
    if (ancestor) {
      return {
        streamId: ancestor.streamId,
        slice: ancestor.value,
      };
    }
  }

  return {
    streamId: activeStreamId,
    slice: activeSlice,
  };
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
  const target = resolveChildListTarget(init);
  return streamTreeEntries({
    activeStreamId: init.activeStreamId,
    childRosters: init.childRosters,
    parentStream: init.parentStream,
    rootStreamId: target.streamId,
    streams: init.streams,
  }).find((entry) => entry.shortcutIndex === shortcutIndex)?.id;
}
