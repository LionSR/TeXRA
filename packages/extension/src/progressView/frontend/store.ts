// Shared imports
import { castDraft, type Draft } from 'mutative';
import {
  createStreamState,
  isToolUseState,
  type AgentCategory,
  type StreamLogEntry,
  type StreamState,
  type StreamTabInfo,
  type StreamTabId,
  type InquiryThreadUpdatedEvent,
  type InquiryThreadId,
} from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import {
  createCompactionActivityProjection,
  type CompactionActivityProjection,
} from '@shared/streams/compactionActivityProjection';

/**
 * Log data stored separately from stream meta state.
 * This separation lets Lit skip re-renders of content components
 * (StreamHeader, TodoList, UsagePanel, FollowUpInput) during streaming —
 * only LogList/TaskGroupList re-render when logs change.
 */
export interface StreamLogs {
  /**
   * Source log entries in append order. Retained beside the rows because a
   * text delta appends to the entry and re-projects it — a row is derived
   * data and is never patched in place — and because a process stream renders
   * its raw output text rather than transcript rows.
   */
  entries: StreamLogEntry[];
  /** O(1) lookup: entry ID → `entries` index. */
  entryIndex: Map<string, number>;
  /**
   * Transcript rows: one per entry that projects to something displayable,
   * plus the compaction-activity rows correlated from several entries.
   * Projected once here so renderers can compare rows by reference.
   */
  rows: TranscriptRow[];
  /** O(1) lookup: row ID → `rows` index. */
  rowIndex: Map<string, number>;
  /** O(1) lookup: task group ID → array index. Maintained by log handlers. */
  taskGroupIndex: Map<string, number>;
  /** Correlated context-compaction lifecycle projected into stable rows. */
  compactionProjection: CompactionActivityProjection;
  /**
   * Existing row indices updated by the most recent backend delta.
   * Pure append batches leave this empty so renderers can skip whole-log scans.
   */
  updatedRowIndices: number[];
  /** Generation immediately before `updatedRowIndices` was collected. */
  updatedRowBaseGeneration: number;
  generation: number;
}

/** Fresh, unshared `StreamLogs` value for a stream with no log entries yet. */
function createEmptyStreamLogs(): StreamLogs {
  return {
    entries: [],
    entryIndex: new Map(),
    rows: [],
    rowIndex: new Map(),
    taskGroupIndex: new Map(),
    compactionProjection: createCompactionActivityProjection(),
    updatedRowIndices: [],
    updatedRowBaseGeneration: 0,
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
  /** Reversible user intent awaiting backend hydration and confirmation. */
  pendingStreamSelection: {
    requestId: string;
    streamId: StreamTabId;
  } | null;
  /** Canonical stream storage — Map preserves insertion order for iteration. */
  streamById: Map<StreamTabId, StreamTabInfo>;
  /** Meta state per stream (status, todos, usage, ui, taskGroups, etc.) */
  streamStates: Map<StreamTabId, StreamState>;
  /** Log messages per stream — separated so log appends don't trigger meta context updates */
  streamLogs: Map<StreamTabId, StreamLogs>;
  /** Durable external inquiry thread summaries, keyed by thread id. */
  inquiries: Map<InquiryThreadId, InquiryThreadUpdatedEvent>;
}

/**
 * Delete one stream's entry from every per-stream map it owns
 * (`streamStates`, `streamLogs`).
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
}

/**
 * Drop reloadable content while retaining the lightweight tab projection and
 * unsent tool-use draft owned by this browser surface.
 */
export function releaseStreamContent(
  draft: Draft<ProgressState>,
  streamId: StreamTabId,
): void {
  draft.streamLogs.delete(streamId);
  const current = draft.streamStates.get(streamId);
  if (!current) return;
  const lightweight = {
    status: current.status,
    substate: current.substate,
    userFollowUpSupport: current.userFollowUpSupport,
    lastTimestamp: current.lastTimestamp,
    conversationProgress: current.conversationProgress,
    stage: current.stage,
    subagents: current.subagents,
    ...(isToolUseState(current) ? { ui: current.ui } : {}),
  };
  draft.streamStates.set(
    streamId,
    createStreamState(current.category, lightweight),
  );
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
 * `deleteStreamState` owns (`streamStates`, `streamLogs`) a stream doesn't
 * have one in yet. Single owner of that initialization logic, mirroring
 * `deleteStreamState`, so a stream can't end up registered in some of these
 * maps but not others depending on which handler happened to observe it
 * first. Already-present entries are left untouched.
 *
 * Does not touch `streamById`, for the same reason `deleteStreamState`
 * doesn't: every call site that introduces a brand-new stream already holds
 * its full `StreamTabInfo` and writes it through the lifecycle reducer — there
 * is no meaningful placeholder to synthesize here.
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
    // See `logSlice.ts`: transcript rows are immutable, so their drafted-object
    // type has to be asserted rather than derived.
    draft.streamLogs.set(streamId, castDraft(createEmptyStreamLogs()));
  }
  return state;
}

export function createInitialState(): ProgressState {
  return {
    activeStreamId: null,
    pendingStreamSelection: null,
    streamById: new Map(),
    streamStates: new Map(),
    streamLogs: new Map(),
    inquiries: new Map(),
  };
}
