import { z } from 'zod';

import {
  AgentCategorySchema,
  DEFAULT_CONVERSATION_PROGRESS,
  DEFAULT_STREAM_METADATA_STATUS,
  StreamMetadataSchema,
  type StreamMetadata,
} from '@shared/schemas';

/**
 * Host-neutral stream metadata builder used by the extension and desktop
 * progress backends before sending UPDATE_STREAMS payloads. Derived from
 * `StreamMetadataSchema` rather than hand-duplicated, so it can't drift from
 * the wire schema. `category` is absent while a stream's run identity is
 * still pending — the frontend renders pending instead of a fabricated kind.
 */
const StreamMetadataInputsSchema = StreamMetadataSchema.partial().extend({
  category: AgentCategorySchema.optional(),
});

export type StreamMetadataInputs = z.infer<typeof StreamMetadataInputsSchema>;

export function buildStreamMetadata(
  inputs: StreamMetadataInputs,
): StreamMetadata {
  return {
    category: inputs.category,
    status: inputs.status ?? DEFAULT_STREAM_METADATA_STATUS,
    substate: inputs.substate,
    userFollowUpSupport: inputs.userFollowUpSupport,
    lastTimestamp: inputs.lastTimestamp,
    conversationProgress: inputs.conversationProgress ?? {
      ...DEFAULT_CONVERSATION_PROGRESS,
    },
    stage: inputs.stage ?? null,
    subagents: inputs.subagents ?? [],
  };
}
