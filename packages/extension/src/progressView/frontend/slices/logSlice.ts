import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_STATUS,
  type ContextStateData,
  type LogMessageData,
  type StreamLogEntry,
} from '@shared/schemas';

import type { StreamLogs, StreamState } from '../store';
import type { HandlerRegistry } from '../messageDispatcher';

function isTaskGroupStatus(
  value: unknown,
): value is
  | typeof STREAM_STATUS.RUNNING
  | typeof STREAM_STATUS.ERROR
  | typeof STREAM_STATUS.STOPPED
  | typeof STREAM_STATUS.READY {
  return (
    value === STREAM_STATUS.RUNNING ||
    value === STREAM_STATUS.ERROR ||
    value === STREAM_STATUS.STOPPED ||
    value === STREAM_STATUS.READY
  );
}

function asContextStateData(data: unknown): ContextStateData | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = data as Partial<ContextStateData>;
  if (
    typeof value.inputTokens === 'number' &&
    typeof value.contextWindow === 'number' &&
    typeof value.utilizationPercent === 'number'
  ) {
    return {
      inputTokens: value.inputTokens,
      contextWindow: value.contextWindow,
      utilizationPercent: value.utilizationPercent,
    };
  }
  return undefined;
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
  entry: StreamLogEntry,
): boolean {
  const payload =
    typeof entry.data === 'object' && entry.data !== null
      ? (entry.data as Record<string, unknown>)
      : {};
  const groupIndex = streamState.taskGroups.findIndex((g) => g.id === entry.id);

  if (entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_START) {
    const status = isTaskGroupStatus(payload.status)
      ? payload.status
      : STREAM_STATUS.RUNNING;
    const nextGroup = {
      id: entry.id,
      name: entry.text ?? String(payload.name ?? entry.id),
      startTime: entry.timestamp,
      status,
      ...(entry.groupId ? { parentGroupId: entry.groupId } : {}),
    };

    if (groupIndex === -1) {
      streamState.taskGroups.push(nextGroup);
    } else {
      streamState.taskGroups[groupIndex] = nextGroup;
    }
    return true;
  }

  if (entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_END) {
    return false;
  }

  const status = isTaskGroupStatus(payload.status)
    ? payload.status
    : STREAM_STATUS.STOPPED;
  const endTime =
    typeof payload.endTime === 'number' ? payload.endTime : undefined;

  if (groupIndex === -1) {
    streamState.taskGroups.push({
      id: entry.id,
      name: entry.text ?? entry.id,
      startTime: entry.timestamp,
      status,
      ...(entry.groupId ? { parentGroupId: entry.groupId } : {}),
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
  let stateChanged = updateTaskGroups(streamState, entry);

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

export const logHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.LOG_DELTA]: (data, ctx) => {
    const { streamId, entries, updates } = data;

    ctx.setState((prev) =>
      create(prev, (draft) => {
        const streamState = draft.streamStates.get(streamId);
        if (!streamState) return;

        const existingStreamLogs = draft.streamLogs.get(streamId);
        const streamLogs: StreamLogs = existingStreamLogs ?? {
          logs: [],
          logIndex: new Map<string, number>(),
          updatedMessageIndices: [],
          updatedMessageBaseGeneration: 0,
          generation: 0,
        };

        let logChanged = false;
        let stateChanged = false;
        const updatedMessageIndices = new Set<number>();
        const updatedMessageBaseGeneration = streamLogs.generation;

        for (const entry of entries) {
          const existingIndex = streamLogs.logIndex.get(entry.id);
          const changed = applyEntry(entry, streamLogs, streamState);
          logChanged ||= changed.logChanged;
          stateChanged ||= changed.stateChanged;
          if (changed.logChanged && existingIndex !== undefined) {
            updatedMessageIndices.add(existingIndex);
          }
        }

        for (const entry of updates) {
          const existingIndex = streamLogs.logIndex.get(entry.id);
          const changed = applyEntry(entry, streamLogs, streamState);
          logChanged ||= changed.logChanged;
          stateChanged ||= changed.stateChanged;
          if (changed.logChanged && existingIndex !== undefined) {
            updatedMessageIndices.add(existingIndex);
          }
        }

        if (logChanged) {
          draft.streamLogs.set(streamId, {
            logs: streamLogs.logs,
            logIndex: streamLogs.logIndex,
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
};
