/** Canonical run metadata records, independent of runtime machinery. */
import { z } from 'zod';

import { byString, normalizeFilePath } from '@utils/core';

import { AgentConfigFieldsSchema } from './agentConfig';
import { JsonValueSchema } from './jsonValue';
import { CompileFailureSummarySchema, OutputFileSummarySchema } from './output';
import { RetryErrorInfoSchema } from './errors';
import { RunOutcomeSchema } from './run';
import { RunUsageTotalsSchema } from './usage';
import type { AgentCategory } from './agent';

export const NonAgentRunRecordSchema = z.strictObject({
  name: z.string().min(1),
  instruction: z.string(),
  workingDirectory: z.string().optional(),
  model: z.string().optional(),
});

/** Inputs have already passed launch validation; persisted records are canonical. */
export const RunRecordFieldsSchema = z.union([
  NonAgentRunRecordSchema,
  AgentConfigFieldsSchema,
]);

const ResultDiffSummarySchema = z.strictObject({
  path: z.string(),
  diffRelPath: z.string(),
  largeChange: z.boolean(),
});
export type ResultDiffSummary = z.infer<typeof ResultDiffSummarySchema>;

/** Terminal errors keep the classified kind beside the provider detail. */
const RunEndErrorSchema = z
  .discriminatedUnion('kind', [
    RetryErrorInfoSchema.pick({
      message: true,
      userRetryable: true,
      streamDiagnostics: true,
      partialText: true,
    })
      .partial()
      .extend({ kind: z.enum(['abort', 'disk-full']) }),
    RetryErrorInfoSchema.partial().extend({
      kind: z.enum(['context-window', 'missing-api-key', 'unexpected']),
    }),
  ])
  .readonly();

/**
 * What a run produced, by category (one run model, section 3.4). The one
 * declaration every result type derives from: the `run.end` row carries it,
 * the flow hands it to the lifecycle, and a producer record embeds it.
 */
export const WorkflowRunEndOutputSchema = z.strictObject({
  category: z.literal('workflow'),
  outputs: z.array(OutputFileSummarySchema).prefault(() => []),
  compileFailures: z.array(CompileFailureSummarySchema).prefault(() => []),
  /** Written by the delivery that computes them, after the run ended. */
  diffs: z.array(ResultDiffSummarySchema).prefault(() => []),
  diffsUnavailable: z.string().optional(),
  structured: JsonValueSchema.optional(),
});
export const ToolUseRunEndOutputSchema = z.strictObject({
  category: z.literal('toolUse'),
  response: z.string().prefault(''),
  /** Workspace-relative paths of files edited by tool calls during the run. */
  files: z.array(z.string()).prefault(() => []),
  /** Value captured by the `submit_output` terminal tool, if the run used one. */
  structured: JsonValueSchema.optional(),
});
const RunEndOutputSchema = z.discriminatedUnion('category', [
  WorkflowRunEndOutputSchema,
  ToolUseRunEndOutputSchema,
]);
export type RunEndOutput = z.infer<typeof RunEndOutputSchema>;

/** The output of a run that ended before its flow produced one. */
export function emptyRunEndOutput(category: AgentCategory): RunEndOutput {
  return RunEndOutputSchema.parse({ category });
}

/**
 * The terminal fact, written once as the `run.end` row. `error` is present
 * only on a failed outcome; `usage` once a round recorded usage, including on
 * failures. Cost is `usage.totalCost` and nothing else.
 */
export const RunEndSchema = z.strictObject({
  outcome: RunOutcomeSchema,
  error: RunEndErrorSchema.optional(),
  usage: RunUsageTotalsSchema.optional(),
  output: RunEndOutputSchema,
});
export type RunEnd = z.infer<typeof RunEndSchema>;

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
    result: RunEndSchema.extend({ output: WorkflowRunEndOutputSchema }),
    copiedOutput: z.string().optional(),
    copiedOutputs: z.array(z.string()).optional(),
  }),
  z.strictObject({
    producer: z.literal('subagent'),
    agentName: z.string(),
    wallTimeMs: z.number().nonnegative(),
    result: RunEndSchema,
    turnToken: z.string().optional(),
  }),
]);
export type ResultMeta = z.infer<typeof ResultMetaSchema>;

/** Canonical workspace paths at the record boundary. */
export const RunWorkspaceFilesSchema = z
  .array(z.string())
  .transform((paths) =>
    [
      ...new Set(
        paths.map((value) => normalizeFilePath(value.trim())).filter(Boolean),
      ),
    ].sort(byString),
  );
