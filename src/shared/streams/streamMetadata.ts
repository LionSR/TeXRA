import {
  DEFAULT_CONVERSATION_PROGRESS,
  DEFAULT_FINISHED_CHILD_COUNT,
  DEFAULT_STREAM_METADATA_STATUS,
  type ActiveChildInfo,
  type AgentCategory,
  type ConversationProgress,
  type RoundStage,
  type StreamMetadata,
  type StreamLifecycleStatus,
  type StreamSubstate,
} from '@shared/schemas';

/**
 * Host-neutral stream metadata builder used by the extension and desktop
 * progress backends before sending UPDATE_STREAMS payloads.
 */
export interface StreamMetadataInputs {
  kind: AgentCategory;
  status?: StreamLifecycleStatus;
  substate?: StreamSubstate;
  lastTimestamp?: number;
  conversationProgress?: ConversationProgress;
  roundStage?: RoundStage | null;
  activeSubagents?: ActiveChildInfo[];
  finishedSubagentCount?: number;
  activeProcesses?: ActiveChildInfo[];
  finishedProcessCount?: number;
}

export function buildStreamMetadata(
  inputs: StreamMetadataInputs,
): StreamMetadata {
  return {
    kind: inputs.kind,
    status: inputs.status ?? DEFAULT_STREAM_METADATA_STATUS,
    substate: inputs.substate,
    lastTimestamp: inputs.lastTimestamp,
    conversationProgress: inputs.conversationProgress ?? {
      ...DEFAULT_CONVERSATION_PROGRESS,
    },
    roundStage: inputs.roundStage ?? null,
    activeSubagents: inputs.activeSubagents ?? [],
    finishedSubagentCount:
      inputs.finishedSubagentCount ?? DEFAULT_FINISHED_CHILD_COUNT,
    activeProcesses: inputs.activeProcesses ?? [],
    finishedProcessCount:
      inputs.finishedProcessCount ?? DEFAULT_FINISHED_CHILD_COUNT,
  };
}
