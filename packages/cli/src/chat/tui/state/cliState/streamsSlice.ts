// Per-stream state map plus the status/child-reference update machinery that
// operates on it. This is the largest slice: every `StreamSlice` field lives
// behind this one map, patched immutably so `useSignal` subscribers only
// re-render on an actual change.

import { signal } from '@lit-labs/signals';

import {
  STREAM_STATUS,
  type ActiveChildInfo,
  type StreamLifecycleStatus,
  type StreamSubstate,
  type StreamTabId,
} from '@shared/schemas';

import { emptySlice, type StreamSlice } from './types';

const STREAMS = signal<ReadonlyMap<StreamTabId, StreamSlice>>(new Map());

/** Per-stream state map, keyed by `StreamTabId`. */
export const streams = STREAMS;

export function patchStream(
  streamId: StreamTabId,
  update: (slice: StreamSlice) => StreamSlice,
): void {
  const current = STREAMS.get();
  const slice = current.get(streamId) ?? emptySlice(streamId);
  const next = update(slice);
  if (next === slice) return;
  const out = new Map(current);
  out.set(streamId, next);
  STREAMS.set(out);
}

function streamSliceWithStatus(
  slice: StreamSlice,
  status: StreamLifecycleStatus,
  substate: StreamSubstate | undefined,
  nowMs: number,
): StreamSlice {
  const runStartedAt =
    status === STREAM_STATUS.RUNNING
      ? (slice.runStartedAt ?? nowMs)
      : undefined;
  if (
    slice.status === status &&
    slice.substate === substate &&
    slice.runStartedAt === runStartedAt
  ) {
    return slice;
  }
  return { ...slice, status, substate, runStartedAt };
}

function updateChildStatusReferences(
  children: readonly ActiveChildInfo[],
  childStreamId: StreamTabId,
  status: StreamLifecycleStatus,
): readonly ActiveChildInfo[] {
  let out: ActiveChildInfo[] | undefined;
  children.forEach((child, index) => {
    if (
      child.kind !== 'subagent' ||
      child.childStreamId !== childStreamId ||
      child.status === status
    ) {
      return;
    }
    out ??= [...children];
    out[index] = { ...child, status };
  });
  return out ?? children;
}

function withMirroredChildStreamStatus(
  slice: StreamSlice,
  childStreamId: StreamTabId,
  status: StreamLifecycleStatus,
): StreamSlice {
  return mapChildStreamReferenceLists(slice, (children) =>
    updateChildStatusReferences(children, childStreamId, status),
  );
}

/**
 * Apply a stream-status event once to the CLI state mirror.
 *
 * Runtime status still originates in StreamStatusService, but TUI renderers
 * should read only StreamSlice data. Updating retained parent child rows here
 * keeps side panels, tab labels, focus routing, and follow-up targeting on the
 * same state snapshot instead of re-querying the runtime service at render time.
 */
export function setStreamStatusInCliState({
  nowMs = Date.now(),
  status,
  substate,
  streamId,
}: {
  readonly nowMs?: number;
  readonly status: StreamLifecycleStatus;
  readonly substate?: StreamSubstate;
  readonly streamId: StreamTabId;
}): void {
  const current = STREAMS.get();
  let out: Map<StreamTabId, StreamSlice> | undefined;

  const existingSlice = current.get(streamId);
  const targetSlice = streamSliceWithStatus(
    existingSlice ?? emptySlice(streamId),
    status,
    substate,
    nowMs,
  );
  if (targetSlice !== existingSlice) {
    out = new Map(current);
    out.set(streamId, targetSlice);
  }

  const readable = out ?? current;
  for (const [id, slice] of readable) {
    const next = withMirroredChildStreamStatus(slice, streamId, status);
    if (next === slice) continue;
    out ??= new Map(current);
    out.set(id, next);
  }

  if (out) STREAMS.set(out);
}

function mapChildStreamReferenceLists(
  slice: StreamSlice,
  mapChildren: (
    children: readonly ActiveChildInfo[],
  ) => readonly ActiveChildInfo[],
): StreamSlice {
  const activeSubagents = mapChildren(slice.activeSubagents);
  const activeProcesses = mapChildren(slice.activeProcesses);
  const childStreams = mapChildren(slice.childStreams);
  if (
    activeSubagents === slice.activeSubagents &&
    activeProcesses === slice.activeProcesses &&
    childStreams === slice.childStreams
  ) {
    return slice;
  }
  return { ...slice, activeSubagents, activeProcesses, childStreams };
}

function removeChildStreamReference(
  children: readonly ActiveChildInfo[],
  streamId: StreamTabId,
): readonly ActiveChildInfo[] {
  const next = children.filter(
    (child) => child.kind !== 'subagent' || child.childStreamId !== streamId,
  );
  return next.length === children.length ? children : next;
}

export function scrubChildStreamReferences(
  slice: StreamSlice,
  streamId: StreamTabId,
): StreamSlice {
  return mapChildStreamReferenceLists(slice, (children) =>
    removeChildStreamReference(children, streamId),
  );
}
