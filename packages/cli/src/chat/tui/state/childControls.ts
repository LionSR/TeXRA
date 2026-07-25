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
import {
  visibleSubagentRows,
  type ChildStreamEntries,
} from './childExecutions';
import type { StreamSlice } from './cliState';

export interface ChildListTarget {
  readonly slice: StreamSlice | undefined;
  readonly streamId: StreamTabId | undefined;
}

function hasLiveChildElapsed(
  child: Pick<ActiveChildInfo, 'startedAt' | 'status'>,
): boolean {
  return (
    child.startedAt !== undefined &&
    (child.status === undefined || child.status === STREAM_PHASE.RUNNING)
  );
}

export function childElapsed(
  child: Pick<ActiveChildInfo, 'elapsed' | 'startedAt' | 'status'>,
  nowMs = Date.now(),
): string | null | undefined {
  const startedAt = child.startedAt;
  if (startedAt === undefined || !hasLiveChildElapsed(child)) {
    return child.elapsed;
  }
  return formatCompactDuration(nowMs - startedAt);
}

function hasChildListItems(
  parentStreamId: StreamTabId | undefined,
  childStreamEntries: ChildStreamEntries,
  streams: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'status'>>,
): boolean {
  if (parentStreamId === undefined) return false;
  return (
    visibleSubagentRows(parentStreamId, childStreamEntries, streams).length > 0
  );
}

/** Resolve the nearest stream whose child sessions populate the persistent
 * child list. */
export function resolveChildListTarget({
  activeStreamId,
  childStreamEntries,
  parentStream,
  streams,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childStreamEntries: ChildStreamEntries;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): ChildListTarget {
  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const activeHasRows = hasChildListItems(
    activeStreamId,
    childStreamEntries,
    streams,
  );
  if (!activeStreamId || activeHasRows) {
    return {
      streamId: activeStreamId,
      slice: activeSlice,
    };
  }

  const ancestor = nearestActiveStreamAncestor({
    activeStreamId,
    parentStream,
    values: streams,
    canUseValue: (_slice, streamId) =>
      hasChildListItems(streamId, childStreamEntries, streams),
  });
  if (ancestor) {
    return {
      streamId: ancestor.streamId,
      slice: ancestor.value,
    };
  }

  return {
    streamId: activeStreamId,
    slice: activeSlice,
  };
}

export function numericFocusTargetForActiveStream(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childStreamEntries: ChildStreamEntries;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly zeroBasedIndex: number;
}): StreamTabId | undefined {
  if (!init.activeStreamId || init.zeroBasedIndex < 0) return undefined;
  const shortcutIndex = init.zeroBasedIndex + 1;
  const target = resolveChildListTarget(init);
  return streamTreeEntries({
    activeStreamId: init.activeStreamId,
    childStreamEntries: init.childStreamEntries,
    parentStream: init.parentStream,
    rootStreamId: target.streamId,
    streams: init.streams,
  }).find((entry) => entry.shortcutIndex === shortcutIndex)?.id;
}
