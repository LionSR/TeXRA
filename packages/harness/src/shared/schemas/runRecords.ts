/** Canonical run metadata records, independent of runtime machinery. */
import { z } from 'zod';

import { byString, normalizeFilePath } from '@utils/core';

import { AgentConfigFieldsSchema } from './agentConfig';
import { JsonValueSchema } from './jsonValue';
import { CompileFailureSummarySchema, OutputFileSummarySchema } from './output';
import { RetryErrorInfoSchema } from './errors';
import { RunOutcomeSchema } from './run';
import { RunUsageTotalsSchema } from './usage';

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

/** Whether a run's config opens a document task: its run is the recipe. */
export function isDocumentTaskConfig(
  config: z.input<typeof RunRecordFieldsSchema>,
): boolean {
  return 'script' in config && config.script?.kind === 'recipe';
}

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
 * The documents a document task produced: its newest documents output, and
 * the diffs the delivery computed after the run ended.
 */
export const RunDocumentsSchema = z.strictObject({
  outputs: z.array(OutputFileSummarySchema).prefault(() => []),
  compileFailures: z.array(CompileFailureSummarySchema).prefault(() => []),
  /** Written by the delivery that computes them, after the run ended. */
  diffs: z.array(ResultDiffSummarySchema).prefault(() => []),
  diffsUnavailable: z.string().optional(),
});
export type RunDocuments = z.infer<typeof RunDocumentsSchema>;

/**
 * What a run produced (one run model, section 3.4): the value the flow hands
 * its lifecycle and every result reader returns. It is read, not stored
 * whole: the reply and a document task's documents are the `run.end` row
 * ({@link RunEndRowSchema}), its diffs the `run.result` of the delivery
 * that computed them.
 */
const RunEndOutputSchema = z.strictObject({
  response: z.string().prefault(''),
  /** Workspace-relative paths of files edited by tool calls during the run. */
  files: z.array(z.string()).prefault(() => []),
  /** Value captured by the `submit_output` terminal tool, if the run used one. */
  structured: JsonValueSchema.optional(),
  /** Present on a document task's run. */
  documents: RunDocumentsSchema.optional(),
});
export type RunEndOutput = z.infer<typeof RunEndOutputSchema>;

/** The output of a run that ended before its flow produced one. */
export function emptyRunEndOutput(): RunEndOutput {
  return RunEndOutputSchema.parse({});
}

/**
 * A run's terminal result as every reader sees it. `error` is present only
 * on a failed outcome; `usage` once a round recorded usage, including on
 * failures. Cost is `usage.totalCost` and nothing else. Derived on read
 * (`readRunEnd`): the usage is the run history's fold of its priced response
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
 * The part of a run's output a row stores: all of it but a document task's
 * diffs, which the delivery that computes them records (`run.result`).
 */
const StoredRunOutputSchema = RunEndOutputSchema;

export function storedRunOutput(output: RunEndOutput): RunEndOutput {
  const { documents } = output;
  if (documents === undefined) return output;
  const { outputs, compileFailures } = documents;
  return { ...output, documents: { outputs, compileFailures, diffs: [] } };
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
const DeliveredDiffsSchema = RunDocumentsSchema.pick({
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
    > & { readonly output: RunEndOutput })
  | (Omit<
      Extract<ResultMeta, { producer: 'subagent' }>,
      'diffs' | 'diffsUnavailable' | 'output'
    > & { readonly output: RunEndOutput });

/** The `run.result` row of a delivered record. */
export function storedResultMeta(result: DeliveredResult): ResultMeta {
  if (result.producer === 'backgroundBash') return result;
  const { output, ...context } = result;
  const { documents } = output;
  const diffs =
    documents === undefined
      ? { diffs: [] }
      : {
          diffs: documents.diffs,
          ...(documents.diffsUnavailable !== undefined
            ? { diffsUnavailable: documents.diffsUnavailable }
            : {}),
        };
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
