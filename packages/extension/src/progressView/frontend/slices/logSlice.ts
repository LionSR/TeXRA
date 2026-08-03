import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  ContextStateDataSchema,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type LogMessageData,
  type ProgressViewOutboundHandlerRegistry,
  type StreamLogEntry,
  type StreamLogTextDelta,
} from '@shared/schemas';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';

import { appState } from '../progressState';
import type { StreamLogs, StreamState } from '../store';

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

interface EntryResult {
  logChanged: boolean;
  stateChanged: boolean;
  /** Index of an existing log replaced in place; absent for appends. */
  updatedIndex?: number;
}

function applyEntry(
  entry: StreamLogEntry,
  streamLogs: StreamLogs,
  streamState: StreamState,
): EntryResult {
  // These records are persisted for diagnostics or live CLI/TUI state, not
  // progress presentation. Drop them before invisible rows consume timeline
  // windows or fall through to the default log formatter.
  if (
    entry.messageType === MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY ||
    entry.messageType === MESSAGE_TYPES.INTERNAL
  ) {
    return { logChanged: false, stateChanged: false };
  }

  let stateChanged = upsertTaskGroupFromStreamLog(
    streamState.taskGroups,
    streamLogs.taskGroupIndex,
    entry,
  );

  if (entry.messageType === MESSAGE_TYPES.CONTEXT_STATE) {
    const contextState = ContextStateDataSchema.safeParse(entry.data);
    if (contextState.success) {
      streamState.contextState = contextState.data;
      stateChanged = true;
    } else {
      // The context gauge silently freezing at its last value is the visible
      // symptom of a producer/schema mismatch, so say so.
      console.warn(
        '[logSlice] Dropped malformed context-state entry',
        contextState.error,
      );
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
  return { logChanged: true, stateChanged, updatedIndex: existingIndex };
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
        const streamEntry = draft.streams.get(streamId);
        if (!streamEntry) return;
        // `streamState`/`streamLogs` are the same draft proxies as
        // `streamEntry.state`/`.logs`, so `applyEntry`'s in-place field
        // mutations (taskGroups, contextState) land on the entry directly —
        // no separate write-back needed, and when `stateChanged` stays
        // false, Mutative keeps `streamEntry.state` reference-stable so a
        // log-only tick doesn't re-render content components that only read
        // stream state.
        const streamState = streamEntry.state;
        const streamLogs: StreamLogs = streamEntry.logs;

        let logChanged = false;
        let stateChanged = false;
        const updatedMessageIndices = new Set<number>();
        const updatedMessageBaseGeneration = streamLogs.generation;

        const processEntry = (entry: StreamLogEntry) => {
          const result = applyEntry(entry, streamLogs, streamState);
          logChanged ||= result.logChanged;
          stateChanged ||= result.stateChanged;
          if (result.updatedIndex !== undefined) {
            updatedMessageIndices.add(result.updatedIndex);
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
          streamEntry.logs = {
            logs: streamLogs.logs,
            logIndex: streamLogs.logIndex,
            taskGroupIndex: streamLogs.taskGroupIndex,
            updatedMessageIndices: [...updatedMessageIndices],
            updatedMessageBaseGeneration,
            generation: streamLogs.generation + 1,
          };
        }

        if (stateChanged) {
          streamEntry.state = streamState;
        }
      }),
    );
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
