// Local imports
import {
  AGENT_CATEGORY,
  createStreamState,
  type AgentCategory,
  type AgentCategoryFilter,
  type ContextState,
  type LogMessageData,
  type SetFollowupOptionsMessage,
  type StreamState,
  type StreamTabInfo,
  type StreamTabId,
} from '@shared/schemas';
import type { StreamSort } from '@shared/streams/streamSort';

// Re-export schema types for components (single source of truth)
export {
  isToolUseState,
  isWorkflowState,
  type FollowupMode,
  type StreamState,
  type ToolUseStreamState,
  type ToolUseUIState,
  type WorkflowStreamState,
  type WorkflowUIState,
} from '@shared/schemas';

export type StreamFilter = AgentCategoryFilter;
export type { ContextState };
export type { StreamSort };

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
  readonly logIndex: ReadonlyMap<string, number>;
}

export const EMPTY_STREAM_LOGS: StreamLogs = {
  logs: [],
  logIndex: new Map(),
};

/** Build StreamLogs from an array, constructing logIndex in one pass. */
export function createStreamLogs(logs: LogMessageData[]): StreamLogs {
  const logIndex = new Map<string, number>();
  for (let i = 0; i < logs.length; i++) {
    logIndex.set(logs[i].id, i);
  }
  return { logs, logIndex };
}

export interface ProgressState {
  activeStreamId: StreamTabId | null;
  streams: StreamTabInfo[];
  streamFilter: StreamFilter;
  streamSort: StreamSort;
  /** Meta state per stream (status, todos, usage, ui, taskGroups, etc.) */
  streamStates: Map<StreamTabId, StreamState>;
  /** Log messages per stream — separated so log appends don't trigger meta context updates */
  streamLogs: Map<StreamTabId, StreamLogs>;
  followupOptionsByStream: Map<StreamTabId, FollowupOptionsState>;
}

export function createInitialState(): ProgressState {
  return {
    activeStreamId: null,
    streams: [],
    streamFilter: 'all',
    streamSort: 'time',
    streamStates: new Map(),
    streamLogs: new Map(),
    followupOptionsByStream: new Map(),
  };
}

/**
 * Get stream state for a stream ID.
 * If state doesn't exist, creates a new state based on agentCategory.
 *
 * IMPORTANT: Always pass agentCategory when creating new stream state.
 * If agentCategory is undefined, defaults to WORKFLOW which may cause
 * tool-use streams to render incorrectly. Callers should look up the
 * category from streamInfo before calling this function.
 */
export function getStreamState(
  state: ProgressState,
  streamId: StreamTabId,
  agentCategory?: AgentCategory,
): StreamState {
  return (
    state.streamStates.get(streamId) ??
    createStreamState(agentCategory ?? AGENT_CATEGORY.WORKFLOW)
  );
}
