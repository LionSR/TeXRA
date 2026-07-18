import { z } from 'zod';

import { AgentCategorySchema } from './agent';
import { ExecutionIdSchema, StreamTabIdSchema } from './identifiers';

export const RUN_DESCRIPTOR_SCHEMA_VERSION = 1;

const RunConfigReferenceSchema = z.strictObject({
  kind: z.literal('executionConfig'),
  executionId: ExecutionIdSchema,
  path: z.string(),
});

export const RunDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(RUN_DESCRIPTOR_SCHEMA_VERSION),
  streamId: StreamTabIdSchema,
  executionId: ExecutionIdSchema,
  agent: z.string().min(1),
  category: AgentCategorySchema,
  configRef: RunConfigReferenceSchema,
});

export type RunDescriptor = z.infer<typeof RunDescriptorSchema>;

export function buildRunDescriptor(input: {
  streamId: z.infer<typeof StreamTabIdSchema>;
  executionId: z.infer<typeof ExecutionIdSchema>;
  agent: string;
  category: z.infer<typeof AgentCategorySchema>;
}): RunDescriptor {
  return RunDescriptorSchema.parse({
    schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
    streamId: input.streamId,
    executionId: input.executionId,
    agent: input.agent,
    category: input.category,
    configRef: {
      kind: 'executionConfig',
      executionId: input.executionId,
      path: `executions/${input.executionId}/config.json`,
    },
  });
}
