// Local imports
import {
  AGENT_CATEGORY,
  createStreamState,
  type AgentCategory,
  type AgentCategoryFilter,
  type ContextStateData,
  type LogMessageData,
  type StreamState,
  type StreamTabInfo,
  type StreamTabId,
  type SetFollowupOptionsMessage,
} from '@shared/schemas';
import type { ProcessOutputMap } from './contexts/streamContexts';

// Re-export schema types for components (single source of truth)
export {
  isToolUseState,
  isWorkflowState,
  type StreamState,
  type ToolUseStreamState,
  type ToolUseUIState,
  type WorkflowStreamState,
} from '@shared/schemas';

export type StreamFilter = AgentCategoryFilter;
export type { ContextStateData };

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
  /**
   * Existing log-message indices updated by the most recent backend delta.
   * Pure append batches leave this empty so renderers can skip whole-log scans.
   */
  updatedMessageIndices: number[];
  /** Generation immediately before `updatedMessageIndices` was collected. */
  updatedMessageBaseGeneration: number;
  generation: number;
}

export const EMPTY_STREAM_LOGS: StreamLogs = {
  logs: [],
  logIndex: new Map(),
  taskGroupIndex: new Map(),
  updatedMessageIndices: [],
  updatedMessageBaseGeneration: 0,
  generation: 0,
};

export interface ProgressState {
  activeStreamId: StreamTabId | null;
  /** Canonical stream storage — Map preserves insertion order for iteration. */
  streamById: Map<StreamTabId, StreamTabInfo>;
  streamFilter: StreamFilter;
  /** Meta state per stream (status, todos, usage, ui, taskGroups, etc.) */
  streamStates: Map<StreamTabId, StreamState>;
  /** Log messages per stream — separated so log appends don't trigger meta context updates */
  streamLogs: Map<StreamTabId, StreamLogs>;
  /** Background process outputs per stream — separated so output appends don't trigger meta context updates.
   *  Outer key: streamId, inner key: executionId → { stdout, stderr }. */
  processOutputs: Map<StreamTabId, ProcessOutputMap>;
  /** Workflow-result follow-up option data, keyed per stream. */
  followupOptionsByStream: Map<StreamTabId, FollowupOptionsState>;
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
    streamFilter: 'all',
    streamStates: new Map(),
    streamLogs: new Map(),
    processOutputs: new Map(),
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
