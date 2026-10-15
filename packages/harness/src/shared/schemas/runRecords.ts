/** Canonical run metadata records, independent of runtime machinery. */
import { z } from 'zod';

import { byString, normalizeFilePath } from '@utils/core';

import { AgentConfigFieldsSchema } from './agentConfig';
import { JsonValueSchema } from './jsonValue';
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

/** Whether the run is a task (an agent carrying a plugin's block, run on
 *  its recipe): its value and its children's spend are its output, its end
 *  its record; it resumes from its checkpoint, its opening rebuilt. */
export const isTaskConfig = (
  config: z.input<typeof RunRecordFieldsSchema>,
): boolean => recipeBlockOf(config) !== null;

/** The block key of the plugin whose recipe the run opened on
 *  (`script.block`), or null for a run that is no task. */
export const recipeBlockOf = (
  config: z.input<typeof RunRecordFieldsSchema>,
): string | null =>
  'script' in config && config.script?.kind === 'recipe'
    ? config.script.block
    : null;

/** Terminal errors keep the classified kind beside the provider detail. */
const RunEndErrorSchema = z
  .discriminatedUnion('kind', [
    RetryErrorInfoSchema.pick({
      message: true,
      userRetryable: true,
      partialText: true,
    })
      .partial()
      // `result-lost`: an end that kept its outcome when its settlement
      // (the result it delivers) was refused.
      .extend({ kind: z.enum(['abort', 'disk-full', 'result-lost']) }),
    RetryErrorInfoSchema.partial().extend({
      kind: z.enum(['context-window', 'missing-api-key', 'unexpected']),
    }),
  ])
  .readonly();

/**
 * What a run produced (one run model, section 3.4): the value the flow hands
 * its lifecycle and every result reader returns, stored whole as the
 * `run.end` row ({@link RunEndRowSchema}).
 */
const RunEndOutputSchema = z.strictObject({
  response: z.string().prefault(''),
  /** Workspace-relative paths of files edited by tool calls during the run. */
  files: z.array(z.string()).prefault(() => []),
  /** Value captured by the `submit_output` terminal tool, or the value a
   *  recipe's script returned (its plugin's block reads it:
   *  `AgentBlock.result`). */
  structured: JsonValueSchema.optional(),
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
 * The terminal fact, written once per lifecycle as the `run.end` row: the
 * outcome, the classified error and the stored output. Every run's usage is
 * its priced response rows'.
 */
export const RunEndRowSchema = RunEndSchema.omit({ usage: true });

/**
 * What a producer recorded beside a run's terminal fact, written as the
 * `run.result` row. It carries only what no other row does: the producer's
 * own context and a subagent's delivered reply (a child loop's `run.end` carries none, by
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
  z.strictObject({
    producer: z.literal('subagent'),
    output: RunEndOutputSchema,
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
