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
export type StreamSort = 'time' | 'agent' | 'inputFile';

export type { ContextState };

/** Followup options derived from schema (minus command field) */
export type FollowupOptionsState = Omit<SetFollowupOptionsMessage, 'command'>;

export interface ProgressState {
  activeStreamId: StreamTabId | null;
  streams: StreamTabInfo[];
  streamFilter: StreamFilter;
  streamSort: StreamSort;
  streamStates: Map<StreamTabId, StreamState>;
  followupOptions: FollowupOptionsState | null;
}

export function createInitialState(): ProgressState {
  return {
    activeStreamId: null,
    streams: [],
    streamFilter: 'all',
    streamSort: 'time',
    streamStates: new Map(),
    followupOptions: null,
  };
}

/**
 * Get stream state for a stream ID.
 * If state doesn't exist, creates a default workflow state.
 * Pass agentCategory to create the correct discriminated type.
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

/**
 * Get the effective run ID for display (selected or active).
 * Only meaningful for workflow streams; tool-use streams don't have run selection.
 */
export function getEffectiveRunId(streamState: StreamState): string | null {
  if (streamState.kind !== AGENT_CATEGORY.WORKFLOW) return null;
  return streamState.selectedRunId ?? streamState.activeRunId;
}
