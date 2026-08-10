// Shared imports
import {
  createStreamState,
  type AgentCategory,
  type LogMessageData,
  type StreamState,
  type StreamTabInfo,
  type StreamTabId,
  type SetFollowupOptionsMessage,
  type InquiryThreadUpdatedEvent,
  type ExternalInquiryThreadId,
} from '@shared/schemas';
import {
  createCompactionActivityProjection,
  type CompactionActivityProjection,
} from '@shared/streams/compactionActivityProjection';
import type { Draft } from 'mutative';

// Re-export schema types for components (single source of truth)
export {
  isToolUseState,
  isWorkflowState,
  type StreamState,
  type ToolUseStreamState,
  type WorkflowStreamState,
  type ContextStateData,
} from '@shared/schemas';

/** Followup options derived from schema (minus command/stream fields) */
export type FollowupOptionsState = Omit<
  SetFollowupOptionsMessage,
  'command' | 'stream'
>;

/**
 * Log data stored separately from stream meta state.
 * This separation lets Lit skip re-renders of content components
 * (StreamHeader, TodoList, UsagePanel, FollowUpInput) during streaming —
 * only LogList/TaskGroupList re-render when logs change.
 */
export interface StreamLogs {
  logs: LogMessageData[];
  /** O(1) lookup: log ID → array index. Maintained by mutation handlers. */
  logIndex: Map<string, number>;
  /** O(1) lookup: task group ID → array index. Maintained by log handlers. */
  taskGroupIndex: Map<string, number>;
  /** Correlated context-compaction lifecycle projected into stable log rows. */
  compactionProjection: CompactionActivityProjection;
  /**
   * Existing log-message indices updated by the most recent backend delta.
   * Pure append batches leave this empty so renderers can skip whole-log scans.
   */
  updatedMessageIndices: number[];
  /** Generation immediately before `updatedMessageIndices` was collected. */
  updatedMessageBaseGeneration: number;
  generation: number;
}

/** Fresh, unshared `StreamLogs` value for a stream with no log entries yet. */
function createEmptyStreamLogs(): StreamLogs {
  return {
    logs: [],
    logIndex: new Map(),
    taskGroupIndex: new Map(),
    compactionProjection: createCompactionActivityProjection(),
    updatedMessageIndices: [],
    updatedMessageBaseGeneration: 0,
    generation: 0,
  };
}

/**
 * Stable empty fallback for read paths (e.g. `activeStreamLogs$`) that need a
 * value before any log has arrived for a stream. Never mutated in place —
 * writers always replace the map entry with a fresh object (see
 * `ensureStreamState` and `logSlice.ts`), so sharing this single reference
 * across reads is safe.
 */
export const EMPTY_STREAM_LOGS: StreamLogs = createEmptyStreamLogs();

export interface ProgressState {
  activeStreamId: StreamTabId | null;
  /** Canonical stream storage — Map preserves insertion order for iteration. */
  streamById: Map<StreamTabId, StreamTabInfo>;
  /** Meta state per stream (status, todos, usage, ui, taskGroups, etc.) */
  streamStates: Map<StreamTabId, StreamState>;
  /** Log messages per stream — separated so log appends don't trigger meta context updates */
  streamLogs: Map<StreamTabId, StreamLogs>;
  /** Workflow-result follow-up option data, keyed per stream. */
  followupOptionsByStream: Map<StreamTabId, FollowupOptionsState>;
  /** Durable external inquiry thread summaries, keyed by thread id. */
  inquiries: Map<ExternalInquiryThreadId, InquiryThreadUpdatedEvent>;
}

/**
 * Delete one stream's entry from every per-stream map it owns
 * (`streamStates`, `streamLogs`, `followupOptionsByStream`).
 * Single owner of that key list so a removed/renamed/added map can't drift
 * out of sync between the lifecycle handlers that garbage-collect streams.
 * Does not touch `streamById` — callers that also drop the stream from the
 * tab list delete that key themselves, since some callers (bulk snapshot
 * sync) replace it wholesale instead.
 */
export function deleteStreamState(
  draft: Draft<ProgressState>,
  streamId: StreamTabId,
): void {
  draft.streamStates.delete(streamId);
  draft.streamLogs.delete(streamId);
  draft.followupOptionsByStream.delete(streamId);
}

/** Clear every visible child edge targeting a deleted parent stream. */
export function detachChildStreamTabs(
  draft: Draft<ProgressState>,
  parentStreamId: StreamTabId,
): void {
  for (const [childId, child] of draft.streamById) {
    if (child.parentStreamId !== parentStreamId) continue;
    draft.streamById.set(childId, { ...child, parentStreamId: undefined });
  }
}

/**
 * Create default entries — for whichever of the same key list
 * `deleteStreamState` owns (`streamStates`, `streamLogs`,
 * `followupOptionsByStream`) a stream doesn't have one in yet. Single owner
 * of that initialization logic, mirroring `deleteStreamState`, so a stream
 * can't end up registered in some of these maps but not others depending on
 * which handler happened to observe it first. Already-present entries are
 * left untouched.
 *
 * Does not touch `streamById`, for the same reason `deleteStreamState`
 * doesn't: every call site that introduces a brand-new stream already holds
 * its full `StreamTabInfo` and writes it through its own logic (e.g. the
 * newest-first sorted upsert in `streamMetaSlice.ts`) — there is no
 * meaningful placeholder to synthesize here.
 *
 * Returns the stream's (possibly just-created) `StreamState`.
 */
export function ensureStreamState(
  draft: Draft<ProgressState>,
  streamId: StreamTabId,
  agentCategory: AgentCategory,
): StreamState {
  let state = draft.streamStates.get(streamId);
  if (!state) {
    state = createStreamState(agentCategory);
    draft.streamStates.set(streamId, state);
  }
  if (!draft.streamLogs.has(streamId)) {
    draft.streamLogs.set(streamId, createEmptyStreamLogs());
  }
  if (!draft.followupOptionsByStream.has(streamId)) {
    draft.followupOptionsByStream.set(streamId, {});
  }
  return state;
}

/** Return the first stream ID from a streamById Map, or null if empty. */
export function firstStreamId(
  streamById: Map<StreamTabId, StreamTabInfo>,
): StreamTabId | null {
  return streamById.keys().next().value ?? null;
}

export function createInitialState(): ProgressState {
  return {
    activeStreamId: null,
    streamById: new Map(),
    streamStates: new Map(),
    streamLogs: new Map(),
    followupOptionsByStream: new Map(),
    inquiries: new Map(),
  };
}
