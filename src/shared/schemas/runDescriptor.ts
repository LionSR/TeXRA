import { z } from 'zod';

import { AgentCategorySchema } from './agent';
import { ExecutionIdSchema, StreamTabIdSchema } from './identifiers';

export const RUN_DESCRIPTOR_SCHEMA_VERSION = 1;

const RunKindSchema = z.enum(['agent', 'process', 'workflowScript']);
export type RunKind = z.infer<typeof RunKindSchema>;

const RunConfigReferenceSchema = z.strictObject({
  kind: z.literal('executionConfig'),
  executionId: ExecutionIdSchema,
  path: z.string(),
});

const RunDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(RUN_DESCRIPTOR_SCHEMA_VERSION),
  streamId: StreamTabIdSchema,
  executionId: ExecutionIdSchema,
  agent: z.string().min(1),
  category: AgentCategorySchema,
  /** What owns the stream: an agent run, an OS process, or a workflow script. */
  kind: RunKindSchema,
  configRef: RunConfigReferenceSchema,
});

export type RunDescriptor = z.infer<typeof RunDescriptorSchema>;

export const PersistedRunDescriptorSchema = RunDescriptorSchema;

export function buildRunDescriptor(input: {
  streamId: z.infer<typeof StreamTabIdSchema>;
  executionId: z.infer<typeof ExecutionIdSchema>;
  agent: string;
  category: z.infer<typeof AgentCategorySchema>;
  kind: RunKind;
}): RunDescriptor {
  return RunDescriptorSchema.parse({
    schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
    streamId: input.streamId,
    executionId: input.executionId,
    agent: input.agent,
    category: input.category,
    kind: input.kind,
    configRef: {
      kind: 'executionConfig',
      executionId: input.executionId,
      path: `executions/${input.executionId}/config.json`,
    },
  });
}
