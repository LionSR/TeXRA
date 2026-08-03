// Shared imports
import {
  type ContextStateData,
  type LogMessageData,
  type StreamState,
  type StreamTabInfo,
  type StreamTabId,
  type SetFollowupOptionsMessage,
  type InquiryThreadUpdatedEvent,
  type ExternalInquiryThreadId,
} from '@shared/schemas';

// Re-export schema types for components (single source of truth)
export {
  isToolUseState,
  isWorkflowState,
  type StreamState,
  type ToolUseStreamState,
  type WorkflowStreamState,
} from '@shared/schemas';

export type { ContextStateData };

/** Followup options derived from schema (minus command/stream fields) */
export type FollowupOptionsState = Omit<
  SetFollowupOptionsMessage,
  'command' | 'stream'
>;

/**
 * Log data stored on a stream's `StreamEntry`, as its own field rather than
 * folded into `state`. See `StreamEntry`'s doc comment for why, and
 * `progressState.ts`'s `streamStates$`/`streamById$` memoized facet views
 * for how the reference stability that separation buys survives now that
 * both live on the same consolidated map entry.
 */
export interface StreamLogs {
  logs: LogMessageData[];
  /** O(1) lookup: log ID → array index. Maintained by mutation handlers. */
  logIndex: Map<string, number>;
  /** O(1) lookup: task group ID → array index. Maintained by log handlers. */
  taskGroupIndex: Map<string, number>;
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
export function createEmptyStreamLogs(): StreamLogs {
  return {
    logs: [],
    logIndex: new Map(),
    taskGroupIndex: new Map(),
    updatedMessageIndices: [],
    updatedMessageBaseGeneration: 0,
    generation: 0,
  };
}

/**
 * Stable empty fallback for read paths (e.g. `activeStreamLogs$`) that need a
 * value before any log has arrived for a stream. Never mutated in place —
 * writers always give a new stream's entry its own fresh `StreamLogs` object
 * (see `createEmptyStreamLogs`), so sharing this single reference across
 * reads is safe.
 */
export const EMPTY_STREAM_LOGS: StreamLogs = createEmptyStreamLogs();

/**
 * One stream's complete frontend record: tab metadata, meta state (status,
 * todos, usage, ui, taskGroups, ...), log messages, and follow-up option
 * data. These four facets used to live in four separately-mutated top-level
 * maps (`streamById`, `streamStates`, `streamLogs`, `followupOptionsByStream`)
 * all keyed by the same `StreamTabId`, plus a `deleteStreamState` /
 * `ensureStreamState` pair that existed only to keep them in sync on
 * removal/creation — any new per-stream facet had to remember to route
 * through both helpers or silently drift out of sync between them. The
 * codebase's own `packages/cli/src/chat/tui/state/childExecutions.ts`
 * documents rejecting this same N-parallel-maps pattern for child-stream
 * state, for the same reason.
 *
 * One map of `StreamEntry` makes that drift structurally impossible: a
 * stream either has a record with all four facets, or it has no record at
 * all — a plain `.get()`/`.set()`/`.delete()` on `ProgressState.streams`
 * replaces every one of the old add/remove helpers.
 *
 * `logs` stays a field of its own on the entry (not folded into `state`),
 * for the same reason the two were separate maps before: log-only ticks
 * (very frequent — e.g. streaming tokens) should leave `state` referentially
 * unchanged so Lit can skip re-rendering content components (StreamHeader,
 * TodoList, UsagePanel, FollowUpInput) that only read state, not logs. See
 * `progressState.ts`'s `streamStates$`/`streamById$` memoized facet views
 * for how that per-field reference stability is preserved now that both
 * live on the same consolidated map entry.
 */
export interface StreamEntry {
  info: StreamTabInfo;
  state: StreamState;
  logs: StreamLogs;
  followupOptions: FollowupOptionsState;
}

export interface ProgressState {
  activeStreamId: StreamTabId | null;
  /** Canonical stream storage — Map preserves insertion order for iteration. */
  streams: Map<StreamTabId, StreamEntry>;
  /** Durable external inquiry thread summaries, keyed by thread id. */
  inquiries: Map<ExternalInquiryThreadId, InquiryThreadUpdatedEvent>;
}

/** Return the first stream ID from a `streams` Map, or null if empty. */
export function firstStreamId(
  streams: ReadonlyMap<StreamTabId, unknown>,
): StreamTabId | null {
  return streams.keys().next().value ?? null;
}

export function createInitialState(): ProgressState {
  return {
    activeStreamId: null,
    streams: new Map(),
    inquiries: new Map(),
  };
}
