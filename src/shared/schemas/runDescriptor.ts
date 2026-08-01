import { z } from 'zod';

import { isProcessAgent } from '@shared/streams/agentKind';

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

/**
 * Disk shape of a persisted descriptor: the canonical one, or one written
 * before `kind` existed (#9119) completed here. Legacy descriptors gain the
 * kind their readers used to re-derive for themselves, so a descriptor that
 * reaches any consumer always carries its full identity. `workflowScript` is
 * unreachable by construction: that kind and this field shipped together, so a
 * descriptor without it predates workflow-script streams being distinguished at
 * all, which is exactly what the old consumer-side derivation assumed.
 */
export const PersistedRunDescriptorSchema = z.union([
  RunDescriptorSchema,
  RunDescriptorSchema.omit({ kind: true }).transform(
    (legacy): RunDescriptor => ({
      ...legacy,
      kind: isProcessAgent(legacy.agent) ? 'process' : 'agent',
    }),
  ),
]);

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
