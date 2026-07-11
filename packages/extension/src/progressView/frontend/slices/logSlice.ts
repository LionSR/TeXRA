import { create } from 'mutative';

import { legacyEndGroupStatusForOutcome } from '@common/constants/streamStatus';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  ContextStateDataSchema,
  GroupLogPayloadSchema,
  MESSAGE_TYPES,
  RunOutcomeSchema,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_STATUS,
  TaskGroupStatusSchema,
  type ContextStateData,
  type LogMessageData,
  type StreamLogEntry,
  type StreamLogTextDelta,
  type TaskGroupStatus,
} from '@shared/schemas';

import type { StreamLogs, StreamState } from '../store';
import type { HandlerRegistry } from '../messageHandlerTypes';

/**
 * A `GROUP_END` row's `data.status` now carries either the legacy 2-value
 * `EndGroupStatus` (rows the standalone trace-viewer forwards raw from an
 * exported trace file — that replay path stays legacy-capable permanently,
 * see docs/proposals/session-scoped-runtime-architecture.md §8.3) or the
 * canonical `RunOutcome` every live/persisted producer now writes (§8.2).
 * Fold a canonical value down to the same legacy bucket the pre-cutover
 * writer used so `TaskGroup.status` — not yet retyped to `StreamPhase`/
 * `RunOutcome` (that reader migration is #7993 goal item 3) — keeps
 * rendering exactly as it does today; only the transcript row itself gains
 * the completed/cancelled bit this step. A value that is neither vocabulary
 * (malformed data) falls back to the caller-supplied default, as before.
 *
 * Both branches parse via the schemas rather than hand-rolled guards —
 * `GroupLogPayloadSchema.status` already validated `value` against the union
 * of the two vocabularies upstream, so these `safeParse` calls just narrow.
 */
function taskGroupEndStatus(
  value: unknown,
  fallback: TaskGroupStatus,
): TaskGroupStatus {
  const legacy = TaskGroupStatusSchema.safeParse(value);
  if (legacy.success) return legacy.data;
  const outcome = RunOutcomeSchema.safeParse(value);
  return outcome.success
    ? legacyEndGroupStatusForOutcome(outcome.data)
    : fallback;
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
    // `GROUP_START` only ever carries the legacy `TaskGroupStatus`
    // vocabulary (never a `RunOutcome` — a run hasn't ended yet), so narrow
    // rather than fold.
    const startStatus = TaskGroupStatusSchema.safeParse(payload.status);
    const nextGroup = {
      id: entry.id,
      name: entry.text ?? payload.name ?? entry.id,
      startTime: entry.timestamp,
      status: startStatus.success ? startStatus.data : STREAM_STATUS.RUNNING,
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

  const status = taskGroupEndStatus(payload.status, STREAM_STATUS.STOPPED);
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

// `HandlerRegistry` is now exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
export const logHandlers = {
  [PROGRESS_VIEW_COMMANDS.LOG_DELTA]: (data, ctx) => {
    const { streamId, entries, updates } = data;
    const textDeltas = data.textDeltas ?? [];

    ctx.setState((prev) =>
      create(prev, (draft) => {
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
} satisfies Partial<HandlerRegistry>;
