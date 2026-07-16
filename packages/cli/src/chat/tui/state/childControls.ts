// Pure state helpers for App-level child execution navigation.

// Local imports - shared schemas
import {
  STREAM_PHASE,
  type ActiveChildInfo,
  type StreamTabId,
} from '@shared/schemas';
import { formatCompactDuration } from '@utils/core';

// Local imports - CLI state
import {
  activeStreamTreeEntries,
  nearestActiveStreamAncestor,
} from './streamViews';
import {
  visibleSubagentRows,
  type ChildStreamEntries,
} from './childExecutions';
import type { ProcessOutputTail, StreamSlice } from './cliState';

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

const EMPTY_TAIL_LINES: readonly string[] = [];
// Tail objects are immutable and replaced wholesale by updateProcessOutput,
// so the split is cached per object: the child list re-renders on every
// stream-sync tick and would otherwise re-split up to 16 KB per process row.
const processTailLinesCache = new WeakMap<
  ProcessOutputTail,
  readonly string[]
>();

export function processTailLines(
  tail: ProcessOutputTail | undefined,
): readonly string[] {
  if (!tail) return EMPTY_TAIL_LINES;
  const cached = processTailLinesCache.get(tail);
  if (cached) return cached;
  const lines = `${tail.stdout}\n${tail.stderr}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  processTailLinesCache.set(tail, lines);
  return lines;
}

function hasChildListItems(
  parentStreamId: StreamTabId | undefined,
  childStreamEntries: ChildStreamEntries,
  streams: ReadonlyMap<
    StreamTabId,
    Pick<StreamSlice, 'activeProcesses' | 'status'>
  >,
): boolean {
  if (parentStreamId === undefined) return false;
  return (
    visibleSubagentRows(parentStreamId, childStreamEntries, streams).length >
      0 || (streams.get(parentStreamId)?.activeProcesses.length ?? 0) > 0
  );
}

/** Resolve the nearest stream whose child sessions or processes populate the
 * persistent child list. */
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

export function liveChildExecutionElapsedKey(
  activeSubagents: readonly ActiveChildInfo[],
  activeProcesses: readonly ActiveChildInfo[],
): string | undefined {
  const liveKeys = [...activeSubagents, ...activeProcesses]
    .filter(hasLiveChildElapsed)
    .map((child) => `${child.executionId}:${child.startedAt}`)
    .sort();
  return liveKeys.length > 0 ? liveKeys.join(',') : undefined;
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
  return activeStreamTreeEntries({
    activeStreamId: init.activeStreamId,
    childStreamEntries: init.childStreamEntries,
    parentStream: init.parentStream,
    streams: init.streams,
  }).find((entry) => entry.shortcutIndex === shortcutIndex)?.id;
}
