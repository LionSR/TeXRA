import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  ContextStateDataSchema,
  END_GROUP_STATUS,
  GroupLogPayloadSchema,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  TaskGroupStatusSchema,
  type ContextStateData,
  type EndGroupStatus,
  type LogMessageData,
  type ProgressViewOutboundHandlerRegistry,
  type StreamLogEntry,
  type StreamLogTextDelta,
  type TaskGroupStatus,
} from '@shared/schemas';

import { appState } from '../progressState';
import type { StreamLogs, StreamState } from '../store';

/**
 * A `GROUP_END` row's `data.status` carries either the native `TaskGroupStatus`
 * (the `StreamPhase` running/completed/cancelled/failed subset) every
 * live/persisted producer writes (§8.2, #7993 step 3's reader retype), or
 * the legacy 2-value `EndGroupStatus` a pre-cutover exported trace file's
 * raw entries still carry — the standalone trace-viewer's `replayTrace()`
 * forwards `trace.entries` verbatim into this same `LOG_DELTA` pipeline, a
 * permanent second boundary (docs/proposals/session-scoped-runtime-
 * architecture.md §8.3). `GroupLogPayloadSchema.status` already validated
 * `value` against the union of both vocabularies upstream, so the native
 * arm here is a `safeParse`-based narrow rather than a hand-rolled type
 * guard; the legacy arm maps a value UP to the same native value
 * `StreamLogStore.parsePersistedEntries` produces for the same on-disk
 * string (`'stopped'` -> `completed`, the documented lossy default; `'error'`
 * -> `failed`) so a task group renders identically whether it arrived live,
 * from a rehydrated stream, or forwarded raw by the trace-viewer. A value
 * that is neither vocabulary (malformed data) falls back to the
 * caller-supplied default, as before.
 */
function taskGroupEndStatus(
  value: TaskGroupStatus | EndGroupStatus | undefined,
  fallback: TaskGroupStatus,
): TaskGroupStatus {
  const native = TaskGroupStatusSchema.safeParse(value);
  if (native.success) return native.data;
  if (value === END_GROUP_STATUS.STOPPED) return STREAM_PHASE.COMPLETED;
  if (value === END_GROUP_STATUS.ERROR) return STREAM_PHASE.FAILED;
  return fallback;
}

function asContextStateData(data: unknown): ContextStateData | undefined {
  return ContextStateDataSchema.optional().catch(undefined).parse(data);
}

function toLogMessage(entry: StreamLogEntry): LogMessageData {
  return {
    id: entry.id,
    text: entry.text ?? '',
    level: entry.level,
    timestamp: entry.timestamp,
    ...(entry.groupId ? { groupId: entry.groupId } : {}),
    ...(entry.messageType ? { messageType: entry.messageType } : {}),
    ...(entry.verbose !== undefined ? { verbose: entry.verbose } : {}),
    ...(entry.data !== undefined ? { data: entry.data } : {}),
  };
}

function updateTaskGroups(
  streamState: StreamState,
  taskGroupIndex: Map<string, number>,
  entry: StreamLogEntry,
): boolean {
  const payload = GroupLogPayloadSchema.catch({}).parse(entry.data);
  const cachedIndex = taskGroupIndex.get(entry.id);
  const groupIndex =
    cachedIndex !== undefined &&
    streamState.taskGroups[cachedIndex]?.id === entry.id
      ? cachedIndex
      : streamState.taskGroups.findIndex((g) => g.id === entry.id);

  if (groupIndex >= 0 && groupIndex !== cachedIndex) {
    taskGroupIndex.set(entry.id, groupIndex);
  }

  if (entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_START) {
    // `GROUP_START` only ever carries the native `TaskGroupStatus`
    // vocabulary (never the legacy `EndGroupStatus` — a run hasn't ended
    // yet), so narrow rather than fold.
    const startStatus = TaskGroupStatusSchema.safeParse(payload.status);
    const nextGroup = {
      id: entry.id,
      name: entry.text ?? payload.name ?? entry.id,
      startTime: entry.timestamp,
      status: startStatus.success ? startStatus.data : STREAM_PHASE.RUNNING,
      ...(entry.groupId ? { parentGroupId: entry.groupId } : {}),
      ...(payload.kind ? { kind: payload.kind } : {}),
      ...(payload.index !== undefined ? { index: payload.index } : {}),
      ...(payload.total !== undefined ? { total: payload.total } : {}),
    };

    if (groupIndex === -1) {
      taskGroupIndex.set(entry.id, streamState.taskGroups.length);
      streamState.taskGroups.push(nextGroup);
    } else {
      streamState.taskGroups[groupIndex] = nextGroup;
    }
    return true;
  }

  if (entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_END) {
    return false;
  }

  const status = taskGroupEndStatus(payload.status, STREAM_PHASE.COMPLETED);
  const endTime = payload.endTime;

  if (groupIndex === -1) {
    taskGroupIndex.set(entry.id, streamState.taskGroups.length);
    streamState.taskGroups.push({
      id: entry.id,
      name: entry.text ?? entry.id,
      startTime: entry.timestamp,
      status,
      ...(entry.groupId ? { parentGroupId: entry.groupId } : {}),
      ...(payload.kind ? { kind: payload.kind } : {}),
      ...(payload.index !== undefined ? { index: payload.index } : {}),
      ...(payload.total !== undefined ? { total: payload.total } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
    });
  } else {
    const current = streamState.taskGroups[groupIndex];
    streamState.taskGroups[groupIndex] = {
      ...current,
      status,
      ...(endTime !== undefined ? { endTime } : {}),
    };
  }

  return true;
}

function applyEntry(
  entry: StreamLogEntry,
  streamLogs: StreamLogs,
  streamState: StreamState,
): { logChanged: boolean; stateChanged: boolean } {
  // This is a live CLI/TUI signal, not progress history. Drop it before
  // indexing so invisible lifecycle markers cannot consume timeline windows.
  if (entry.messageType === MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY) {
    return { logChanged: false, stateChanged: false };
  }

  let stateChanged = updateTaskGroups(
    streamState,
    streamLogs.taskGroupIndex,
    entry,
  );

  if (entry.messageType === MESSAGE_TYPES.CONTEXT_STATE) {
    const contextState = asContextStateData(entry.data);
    if (contextState) {
      streamState.contextState = contextState;
      stateChanged = true;
    }
  }

  if (entry.type !== STREAM_LOG_ENTRY_TYPES.LOG) {
    return { logChanged: false, stateChanged };
  }

  const nextLog = toLogMessage(entry);
  const existingIndex = streamLogs.logIndex.get(entry.id);
  if (existingIndex === undefined) {
    streamLogs.logIndex.set(entry.id, streamLogs.logs.length);
    streamLogs.logs.push(nextLog);
    return { logChanged: true, stateChanged };
  }

  streamLogs.logs[existingIndex] = nextLog;
  return { logChanged: true, stateChanged };
}

function applyTextDelta(
  delta: StreamLogTextDelta,
  streamLogs: StreamLogs,
): number | undefined {
  const existingIndex = streamLogs.logIndex.get(delta.id);
  if (existingIndex === undefined) return undefined;

  const current = streamLogs.logs[existingIndex];
  if (!current) return undefined;

  streamLogs.logs[existingIndex] = {
    ...current,
    text: `${current.text}${delta.appendText}`,
  };
  return existingIndex;
}

// The composed registry is exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
export const logHandlers = {
  [PROGRESS_VIEW_COMMANDS.LOG_DELTA]: (data) => {
    const { streamId, entries, updates } = data;
    const textDeltas = data.textDeltas ?? [];

    appState.set(
      create(appState.get(), (draft) => {
        const streamState = draft.streamStates.get(streamId);
        if (!streamState) return;

        const existingStreamLogs = draft.streamLogs.get(streamId);
        const streamLogs: StreamLogs = existingStreamLogs ?? {
          logs: [],
          logIndex: new Map<string, number>(),
          taskGroupIndex: new Map<string, number>(),
          updatedMessageIndices: [],
          updatedMessageBaseGeneration: 0,
          generation: 0,
        };

        let logChanged = false;
        let stateChanged = false;
        const updatedMessageIndices = new Set<number>();
        const updatedMessageBaseGeneration = streamLogs.generation;

        const processEntry = (entry: StreamLogEntry) => {
          const existingIndex = streamLogs.logIndex.get(entry.id);
          const changed = applyEntry(entry, streamLogs, streamState);
          logChanged ||= changed.logChanged;
          stateChanged ||= changed.stateChanged;
          if (changed.logChanged && existingIndex !== undefined) {
            updatedMessageIndices.add(existingIndex);
          }
        };

        // `entries` (appends/upserts) and `updates` (in-place edits) get
        // identical treatment; keep their ordering without allocating a
        // combined array in the streaming update path.
        for (const entry of entries) processEntry(entry);
        for (const entry of updates) processEntry(entry);
        for (const delta of textDeltas) {
          const existingIndex = applyTextDelta(delta, streamLogs);
          if (existingIndex !== undefined) {
            logChanged = true;
            updatedMessageIndices.add(existingIndex);
          }
        }

        if (logChanged) {
          draft.streamLogs.set(streamId, {
            logs: streamLogs.logs,
            logIndex: streamLogs.logIndex,
            taskGroupIndex: streamLogs.taskGroupIndex,
            updatedMessageIndices: [...updatedMessageIndices],
            updatedMessageBaseGeneration,
            generation: streamLogs.generation + 1,
          });
        }

        if (stateChanged) {
          draft.streamStates.set(streamId, streamState);
        }
      }),
    );
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
