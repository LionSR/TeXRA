import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  ActiveSkillsSnapshotSchema,
  ContextStateDataSchema,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  isToolUseState,
  type LogMessageData,
  type ProgressViewOutboundHandlerRegistry,
  type StreamLogEntry,
  type StreamLogTextDelta,
  type StreamState,
} from '@shared/schemas';
import {
  applyCompactionActivityEntries,
  settleCompactionActivities,
} from '@shared/streams/compactionActivityProjection';
import { isTranscriptSettlementPhase } from '@shared/streams/streamStatus';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';

import { appState } from '../progressState';
import { ensureStreamState, type StreamLogs } from '../store';

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
  /** Existing log indices replaced in place; appends are absent. */
  updatedIndices: readonly number[];
}

function syncCompactionProjectionChanges(
  streamLogs: StreamLogs,
  changedIndices: readonly number[],
): Pick<EntryResult, 'logChanged' | 'updatedIndices'> {
  const updatedIndices: number[] = [];
  let logChanged = false;

  for (const blockIndex of changedIndices) {
    const block = streamLogs.compactionProjection.blocks[blockIndex];
    if (!block) continue;
    const id = `compaction:${block.operationId}`;
    const nextLog: LogMessageData = {
      id,
      text: '',
      level: 'info',
      timestamp: block.startedAt,
      messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
      data: block,
    };
    const existingIndex = streamLogs.logIndex.get(id);
    if (existingIndex === undefined) {
      streamLogs.logIndex.set(id, streamLogs.logs.length);
      streamLogs.logs.push(nextLog);
    } else {
      streamLogs.logs[existingIndex] = nextLog;
      updatedIndices.push(existingIndex);
    }
    logChanged = true;
  }

  return { logChanged, updatedIndices };
}

/** Settle unmatched activity rows when the current transcript turn settles. */
export function settleCompactionActivityLogs(
  streamLogs: StreamLogs,
  options: {
    readonly throughSeqNo?: number;
    readonly finishedAt?: number;
  },
): readonly number[] {
  const changedIndices = settleCompactionActivities(
    streamLogs.compactionProjection,
    options,
  );
  return syncCompactionProjectionChanges(streamLogs, changedIndices)
    .updatedIndices;
}

function applyEntry(
  entry: StreamLogEntry,
  streamLogs: StreamLogs,
  streamState: StreamState,
): EntryResult {
  if (entry.messageType === MESSAGE_TYPES.ACTIVE_SKILLS) {
    if (!isToolUseState(streamState)) {
      return { logChanged: false, stateChanged: false, updatedIndices: [] };
    }
    const snapshot = ActiveSkillsSnapshotSchema.safeParse(entry.data);
    if (!snapshot.success) {
      console.warn(
        '[logSlice] Cleared malformed active-skills entry',
        snapshot.error,
      );
    }
    streamState.activeSkills = snapshot.success ? snapshot.data.skills : [];
    return { logChanged: false, stateChanged: true, updatedIndices: [] };
  }

  const compactionResult = syncCompactionProjectionChanges(
    streamLogs,
    applyCompactionActivityEntries(streamLogs.compactionProjection, [entry]),
  );
  // Internal records remain diagnostic-only. Raw compaction lifecycle records
  // are replaced by the correlated stable row projected above.
  if (
    entry.messageType === MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY ||
    entry.messageType === MESSAGE_TYPES.INTERNAL
  ) {
    return { ...compactionResult, stateChanged: false };
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
    return { ...compactionResult, stateChanged };
  }

  const nextLog = toLogMessage(entry);
  const existingIndex = streamLogs.logIndex.get(entry.id);
  if (existingIndex === undefined) {
    streamLogs.logIndex.set(entry.id, streamLogs.logs.length);
    streamLogs.logs.push(nextLog);
    return { ...compactionResult, logChanged: true, stateChanged };
  }

  streamLogs.logs[existingIndex] = nextLog;
  return {
    ...compactionResult,
    logChanged: true,
    stateChanged,
    updatedIndices: [...compactionResult.updatedIndices, existingIndex],
  };
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

// Registry contract: every outbound command needs a handler or
// `unsupported(...)`; exhaustiveness is enforced at the composed spread in
// messageDispatcher.ts. This slice only owns a subset.
export const logHandlers = {
  [PROGRESS_VIEW_COMMANDS.LOG_DELTA]: (data) => {
    const { streamId, entries, updates } = data;
    const textDeltas = data.textDeltas ?? [];

    appState.set(
      create(appState.get(), (draft) => {
        const streamState = draft.streamStates.get(streamId);
        if (!streamState) return;

        // Backfills streamLogs (and followupOptionsByStream) if this is the
        // first handler to observe the stream — see `ensureStreamState`.
        ensureStreamState(draft, streamId, streamState.category);
        // Non-null: ensureStreamState above guarantees this entry exists.
        const streamLogs: StreamLogs = draft.streamLogs.get(streamId)!;

        let logChanged = false;
        let stateChanged = false;
        const updatedMessageIndices = new Set<number>();
        const updatedMessageBaseGeneration = streamLogs.generation;

        const processEntry = (entry: StreamLogEntry) => {
          const result = applyEntry(entry, streamLogs, streamState);
          logChanged ||= result.logChanged;
          stateChanged ||= result.stateChanged;
          for (const index of result.updatedIndices) {
            updatedMessageIndices.add(index);
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
        if (isTranscriptSettlementPhase(streamState.status)) {
          for (const index of settleCompactionActivityLogs(streamLogs, {
            finishedAt: streamState.lastTimestamp,
          })) {
            logChanged = true;
            updatedMessageIndices.add(index);
          }
        }

        if (logChanged) {
          draft.streamLogs.set(streamId, {
            logs: streamLogs.logs,
            logIndex: streamLogs.logIndex,
            taskGroupIndex: streamLogs.taskGroupIndex,
            compactionProjection: streamLogs.compactionProjection,
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
