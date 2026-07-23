import { z } from 'zod';

import {
  AgentCategorySchema,
  DEFAULT_CONVERSATION_PROGRESS,
  DEFAULT_FINISHED_CHILD_COUNT,
  DEFAULT_STREAM_METADATA_STATUS,
  StreamMetadataSchema,
  type StreamMetadata,
} from '@shared/schemas';

/**
 * Host-neutral stream metadata builder used by the extension and desktop
 * progress backends before sending UPDATE_STREAMS payloads. Derived from
 * `StreamMetadataSchema` (every field optional except `kind`) rather than
 * hand-duplicated, so it can't drift from the wire schema.
 */
const StreamMetadataInputsSchema = StreamMetadataSchema.partial().extend({
  kind: AgentCategorySchema,
});

export type StreamMetadataInputs = z.infer<typeof StreamMetadataInputsSchema>;

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
