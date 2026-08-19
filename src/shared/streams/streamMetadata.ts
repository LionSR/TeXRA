import { z } from 'zod';

import {
  AgentCategorySchema,
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
    // BackendOwnedFieldsSchema's .prefault() members are the single source of
    // truth for the backend-owned defaults — parse through StreamMetadataSchema
    // so a default added there can't silently miss this builder's output. Only
    // the two semantics the schema can't express are owned here: `stage` is
    // normalized to an explicit null (the wire's "clear the held stage"
    // signal) and the optional passthrough fields are restored so the returned
    // shape always carries them.
    ...StreamMetadataSchema.parse({
      ...inputs,
      stage: inputs.stage ?? null,
    }),
    substate: inputs.substate,
    runStartedAt: inputs.runStartedAt,
    userFollowUpSupport: inputs.userFollowUpSupport,
    lastTimestamp: inputs.lastTimestamp,
    category: inputs.category,
  };
}
