import { castDraft, create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  isToolUseState,
  type ProgressViewOutboundHandlerRegistry,
  type StreamLogEntry,
  type StreamLogTextDelta,
  type StreamState,
} from '@shared/schemas';
import {
  compactionActivityRow,
  projectTranscriptRow,
} from '@shared/transcript';
import {
  applyCompactionActivityEntries,
  settleCompactionActivities,
} from '@shared/streams/compactionActivityProjection';
import { isTranscriptSettlementPhase } from '@shared/streams/streamStatus';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

import { appState, subagentExecutionLabels } from '../progressState';
import { ensureStreamState, type StreamLogs } from '../store';

interface EntryResult {
  logChanged: boolean;
  stateChanged: boolean;
  /** Existing row indices replaced in place; appends are absent. */
  updatedIndices: readonly number[];
}

const NO_CHANGE: EntryResult = {
  logChanged: false,
  stateChanged: false,
  updatedIndices: [],
};

/** Row positions shift on removal, so the id → index map is rebuilt from it. */
function reindexRows(streamLogs: StreamLogs, fromIndex: number): void {
  for (let i = fromIndex; i < streamLogs.rows.length; i++) {
    streamLogs.rowIndex.set(streamLogs.rows[i].id, i);
  }
}

/**
 * Merge one entry's projection into the row list: append a new row, replace an
 * existing one, or drop a row whose entry no longer projects to anything
 * displayable. Returns the replaced index, or undefined for an append/removal
 * (both of which change the array length, so index-keyed patching does not
 * apply).
 */
function syncRow(
  streamLogs: StreamLogs,
  entry: StreamLogEntry,
  executionLabels: ExecutionLabels,
): Pick<EntryResult, 'logChanged' | 'updatedIndices'> {
  const row = projectTranscriptRow(entry, {
    executionLabels,
    projectLifecycleToTaskGroups: true,
  });
  const existingIndex = streamLogs.rowIndex.get(entry.id);

  if (!row) {
    if (existingIndex === undefined) return NO_CHANGE;
    streamLogs.rows.splice(existingIndex, 1);
    streamLogs.rowIndex.delete(entry.id);
    reindexRows(streamLogs, existingIndex);
    return { logChanged: true, updatedIndices: [] };
  }

  if (existingIndex === undefined) {
    streamLogs.rowIndex.set(row.id, streamLogs.rows.length);
    streamLogs.rows.push(row);
    return { logChanged: true, updatedIndices: [] };
  }

  streamLogs.rows[existingIndex] = row;
  return { logChanged: true, updatedIndices: [existingIndex] };
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
    const row = compactionActivityRow(block);
    const existingIndex = streamLogs.rowIndex.get(row.id);
    if (existingIndex === undefined) {
      streamLogs.rowIndex.set(row.id, streamLogs.rows.length);
      streamLogs.rows.push(row);
    } else {
      streamLogs.rows[existingIndex] = row;
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
  executionLabels: ExecutionLabels,
): EntryResult {
  if (entry.messageType === MESSAGE_TYPES.ACTIVE_SKILLS) {
    if (!isToolUseState(streamState)) return NO_CHANGE;
    streamState.activeSkills = entry.data.skills;
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
    streamState.contextState = entry.data;
    stateChanged = true;
  }

  // Run/round/phase headings are this host's task-group surface, not
  // transcript rows.
  if (entry.type !== STREAM_LOG_ENTRY_TYPES.LOG) {
    return { ...compactionResult, stateChanged };
  }

  const existingEntryIndex = streamLogs.entryIndex.get(entry.id);
  if (existingEntryIndex === undefined) {
    streamLogs.entryIndex.set(entry.id, streamLogs.entries.length);
    streamLogs.entries.push(entry);
  } else {
    streamLogs.entries[existingEntryIndex] = entry;
  }

  const rowResult = syncRow(streamLogs, entry, executionLabels);
  return {
    logChanged: compactionResult.logChanged || rowResult.logChanged,
    stateChanged,
    updatedIndices: [
      ...compactionResult.updatedIndices,
      ...rowResult.updatedIndices,
    ],
  };
}

function applyTextDelta(
  delta: StreamLogTextDelta,
  streamLogs: StreamLogs,
  executionLabels: ExecutionLabels,
): Pick<EntryResult, 'logChanged' | 'updatedIndices'> {
  const entryIndex = streamLogs.entryIndex.get(delta.id);
  if (entryIndex === undefined) return NO_CHANGE;

  const current = streamLogs.entries[entryIndex];
  if (!current) return NO_CHANGE;

  const appended = {
    ...current,
    text: `${current.text ?? ''}${delta.appendText}`,
  };
  streamLogs.entries[entryIndex] = appended;
  return syncRow(streamLogs, appended, executionLabels);
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

        // Backfills streamLogs if this is the first handler to observe the
        // stream — see `ensureStreamState`.
        ensureStreamState(draft, streamId, streamState.category);
        // Non-null: ensureStreamState above guarantees this entry exists.
        const streamLogs: StreamLogs = draft.streamLogs.get(streamId)!;
        // Subagent identities are session-wide and already registered by the
        // time a call targets one, so the tool rows this batch projects carry
        // their labels instead of resolving them again at paint.
        const executionLabels = subagentExecutionLabels(
          draft.streamById.values(),
        );

        let logChanged = false;
        let stateChanged = false;
        const updatedRowIndices = new Set<number>();
        const updatedRowBaseGeneration = streamLogs.generation;

        const collect = (
          result: Pick<EntryResult, 'logChanged' | 'updatedIndices'>,
        ): void => {
          logChanged ||= result.logChanged;
          for (const index of result.updatedIndices) {
            updatedRowIndices.add(index);
          }
        };

        const processEntry = (entry: StreamLogEntry) => {
          const result = applyEntry(
            entry,
            streamLogs,
            streamState,
            executionLabels,
          );
          stateChanged ||= result.stateChanged;
          collect(result);
        };

        // `entries` (appends/upserts) and `updates` (in-place edits) get
        // identical treatment; keep their ordering without allocating a
        // combined array in the streaming update path.
        for (const entry of entries) processEntry(entry);
        for (const entry of updates) processEntry(entry);
        for (const delta of textDeltas) {
          collect(applyTextDelta(delta, streamLogs, executionLabels));
        }
        if (isTranscriptSettlementPhase(streamState.status)) {
          for (const index of settleCompactionActivityLogs(streamLogs, {
            finishedAt: streamState.lastTimestamp,
          })) {
            logChanged = true;
            updatedRowIndices.add(index);
          }
        }

        if (logChanged) {
          // `castDraft` only re-labels the value's type: transcript rows are
          // immutable by construction (replaced, never patched), so mutative's
          // drafted-object type cannot be derived from them.
          draft.streamLogs.set(
            streamId,
            castDraft({
              entries: streamLogs.entries,
              entryIndex: streamLogs.entryIndex,
              rows: streamLogs.rows,
              rowIndex: streamLogs.rowIndex,
              taskGroupIndex: streamLogs.taskGroupIndex,
              compactionProjection: streamLogs.compactionProjection,
              updatedRowIndices: [...updatedRowIndices],
              updatedRowBaseGeneration,
              generation: streamLogs.generation + 1,
            }),
          );
        }

        if (stateChanged) {
          draft.streamStates.set(streamId, streamState);
        }
      }),
    );
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
