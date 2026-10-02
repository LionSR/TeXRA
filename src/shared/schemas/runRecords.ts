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

/**
 * Terminal errors keep the classified kind beside the provider detail.
 *
 * `artifact-drain` is a durability marker rather than a run that failed: the
 * facts the run had queued rolled back before its terminal row was written
 * (`finalizeRunTerminal`), so every later reader of the row can tell "the
 * drain lost what this run recorded" from "the model run failed" without the
 * in-process error that decided it.
 */
const RunEndErrorSchema = z
  .discriminatedUnion('kind', [
    RetryErrorInfoSchema.pick({
      message: true,
      userRetryable: true,
      partialText: true,
    })
      .partial()
      .extend({ kind: z.enum(['abort', 'artifact-drain', 'disk-full']) }),
    RetryErrorInfoSchema.partial().extend({
      kind: z.enum(['context-window', 'missing-api-key', 'unexpected']),
    }),
  ])
  .readonly();

/**
 * What a run produced, by category (one run model, section 3.4): the value
 * the flow hands its lifecycle and every result reader returns. It is read,
 * not stored whole: a workflow run's files are its newest `output.produced`
 * row, its diffs the `run.result` of the delivery that computed them, and a
 * tool-use run's reply the `run.end` row ({@link RunEndRowSchema}).
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
 * A run's terminal result as every reader sees it. `error` is present only
 * on a failed outcome; `usage` once a round recorded usage, including on
 * failures. Cost is `usage.totalCost` and nothing else. Derived on read
 * (`readRunEnd`): the usage is the run ledger's fold of its priced response
 * rows, the output as {@link RunEndOutputSchema} says.
 */
export const RunEndSchema = z.strictObject({
  outcome: RunOutcomeSchema,
  error: RunEndErrorSchema.optional(),
  usage: RunUsageTotalsSchema.optional(),
  output: RunEndOutputSchema,
});
export type RunEnd = z.infer<typeof RunEndSchema>;

/**
 * The part of a run's output a row stores: a tool-use run's reply, which no
 * other row holds. A workflow run's files are its `output.produced` rows, so
 * a stored workflow output names only its category.
 */
const StoredRunOutputSchema = z.discriminatedUnion('category', [
  WorkflowRunEndOutputSchema.pick({ category: true }),
  ToolUseRunEndOutputSchema,
]);

export function storedRunOutput(
  output: RunEndOutput,
): z.infer<typeof StoredRunOutputSchema> {
  return output.category === 'workflow'
    ? { category: output.category }
    : output;
}

/**
 * The terminal fact, written once per lifecycle as the `run.end` row: the
 * outcome, the classified error and the stored output. Every run's usage is
 * its priced response rows'.
 */
export const RunEndRowSchema = RunEndSchema.omit({
  usage: true,
  output: true,
}).extend({ output: StoredRunOutputSchema });

/** The part of a result's diffs a delivery computes after the run ended. */
const DeliveredDiffsSchema = WorkflowRunEndOutputSchema.pick({
  diffs: true,
  diffsUnavailable: true,
});

/**
 * What a producer recorded beside a run's terminal fact, written as the
 * `run.result` row. It carries only what no other row does: the producer's
 * own context, the diffs the delivery computed after the flow reported, and
 * a subagent's delivered reply (a child loop's `run.end` carries none, by
 * rule, and a child waiting for its next turn has none yet). Outcome, error,
 * usage and a workflow's files are read from their own rows — never copied
 * here (one run model, section 3.3).
 */
export const ResultMetaSchema = z.discriminatedUnion('producer', [
  z.strictObject({
    producer: z.literal('backgroundBash'),
    exitCode: z.int().optional(),
    wallTimeMs: z.number().nonnegative(),
    success: z.boolean(),
    timedOut: z.boolean().optional(),
    command: z.string(),
  }),
  DeliveredDiffsSchema.extend({
    producer: z.literal('cliWorkflow'),
    copiedOutput: z.string().optional(),
    copiedOutputs: z.array(z.string()).optional(),
  }),
  DeliveredDiffsSchema.extend({
    producer: z.literal('subagent'),
    agentName: z.string(),
    wallTimeMs: z.number().nonnegative(),
    output: StoredRunOutputSchema,
  }),
]);
export type ResultMeta = z.infer<typeof ResultMetaSchema>;

/**
 * A producer's record as its delivery holds it in memory: its whole output.
 * {@link storedResultMeta} keeps of it what no other row holds.
 */
export type DeliveredResult =
  | Extract<ResultMeta, { producer: 'backgroundBash' }>
  | (Omit<
      Extract<ResultMeta, { producer: 'cliWorkflow' }>,
      'diffs' | 'diffsUnavailable'
    > & { readonly output: z.infer<typeof WorkflowRunEndOutputSchema> })
  | (Omit<
      Extract<ResultMeta, { producer: 'subagent' }>,
      'diffs' | 'diffsUnavailable' | 'output'
    > & { readonly output: RunEndOutput });

/** The `run.result` row of a delivered record. */
export function storedResultMeta(result: DeliveredResult): ResultMeta {
  if (result.producer === 'backgroundBash') return result;
  const { output, ...context } = result;
  const diffs =
    output.category === 'workflow'
      ? {
          diffs: output.diffs,
          ...(output.diffsUnavailable !== undefined
            ? { diffsUnavailable: output.diffsUnavailable }
            : {}),
        }
      : { diffs: [] };
  return context.producer === 'subagent'
    ? { ...context, ...diffs, output: storedRunOutput(output) }
    : { ...context, ...diffs };
}

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
