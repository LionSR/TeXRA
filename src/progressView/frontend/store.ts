// Local imports
import {
  AGENT_CATEGORY,
  createStreamState,
  type AgentCategory,
  type AgentCategoryFilter,
  type ContextState,
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
  type WorkflowStreamState,
} from '@shared/schemas';

export type StreamFilter = AgentCategoryFilter;
export type { ContextState };
export type { StreamSort };

/** Followup options derived from schema (minus command field) */
export type FollowupOptionsState = Omit<
  SetFollowupOptionsMessage,
  'command' | 'stream'
>;

export interface ProgressState {
  activeStreamId: StreamTabId | null;
  streams: StreamTabInfo[];
  streamFilter: StreamFilter;
  streamSort: StreamSort;
  streamStates: Map<StreamTabId, StreamState>;
  followupOptionsByStream: Map<StreamTabId, FollowupOptionsState>;
}

export function createInitialState(): ProgressState {
  return {
    activeStreamId: null,
    streams: [],
    streamFilter: 'all',
    streamSort: 'time',
    streamStates: new Map(),
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
