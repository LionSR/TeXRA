/** Canonical execution metadata records, independent of runtime machinery. */
import { z } from 'zod';

import { byString, normalizeFilePath } from '@utils/core';

import { AgentConfigFieldsSchema } from './agentConfig';
import { ExecutionIdSchema } from './identifiers';
import { JsonValueSchema } from './jsonValue';
import { CompileFailureSummarySchema, OutputFileSummarySchema } from './output';
import { RetryErrorInfoSchema } from './errors';
import { RunOutcomeSchema } from './stream';

export const NonAgentRunRecordSchema = z.strictObject({
  name: z.string().min(1),
  instruction: z.string(),
  workingDirectory: z.string().optional(),
  model: z.string().optional(),
});

/** Inputs have already passed launch validation; persisted records are canonical. */
export const ExecutionRunRecordSchema = z.union([
  NonAgentRunRecordSchema,
  AgentConfigFieldsSchema,
]);

const ResultDiffSummarySchema = z.strictObject({
  path: z.string(),
  diffRelPath: z.string(),
  largeChange: z.boolean(),
});
export type ResultDiffSummary = z.infer<typeof ResultDiffSummarySchema>;

const CostSchema = z.number().nonnegative().prefault(0);
const WorkflowAgentFinalResultSchema = z.strictObject({
  category: z.literal('workflow'),
  outcome: RunOutcomeSchema,
  outputs: z.array(OutputFileSummarySchema).prefault(() => []),
  compileFailures: z.array(CompileFailureSummarySchema).prefault(() => []),
  diffs: z.array(ResultDiffSummarySchema).prefault(() => []),
  cost: CostSchema,
  diffsUnavailable: z.string().optional(),
  structured: JsonValueSchema.optional(),
  error: RetryErrorInfoSchema.optional(),
});
const ToolUseAgentFinalResultSchema = z.strictObject({
  category: z.literal('toolUse'),
  outcome: RunOutcomeSchema,
  response: z.string().prefault(''),
  files: z.array(z.string()).prefault(() => []),
  cost: CostSchema,
  structured: JsonValueSchema.optional(),
  error: RetryErrorInfoSchema.optional(),
});
export const AgentFinalResultSchema = z.discriminatedUnion('category', [
  WorkflowAgentFinalResultSchema,
  ToolUseAgentFinalResultSchema,
]);
export type AgentFinalResult = z.infer<typeof AgentFinalResultSchema>;

export const ResultMetaSchema = z.discriminatedUnion('producer', [
  z.strictObject({
    producer: z.literal('backgroundBash'),
    exitCode: z.int().optional(),
    wallTimeMs: z.number().nonnegative(),
    success: z.boolean(),
    timedOut: z.boolean().optional(),
    command: z.string(),
  }),
  z.strictObject({
    producer: z.literal('cliWorkflow'),
    result: WorkflowAgentFinalResultSchema,
    copiedOutput: z.string().optional(),
    copiedOutputs: z.array(z.string()).optional(),
  }),
  z.strictObject({
    producer: z.literal('subagent'),
    agentName: z.string(),
    parentExecutionId: ExecutionIdSchema.optional(),
    wallTimeMs: z.number().nonnegative(),
    result: AgentFinalResultSchema,
    turnToken: z.string().optional(),
  }),
]);
export type ResultMeta = z.infer<typeof ResultMetaSchema>;

/** Canonical workspace paths at the record boundary. */
export const ExecutionWorkspaceFilesSchema = z
  .array(z.string())
  .transform((paths) =>
    [
      ...new Set(
        paths.map((value) => normalizeFilePath(value.trim())).filter(Boolean),
      ),
    ].sort(byString),
  );
