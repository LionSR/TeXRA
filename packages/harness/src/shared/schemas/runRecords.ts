/** Canonical run metadata records, independent of runtime machinery. */
import { Effect, Schema, SchemaGetter, Struct } from 'effect';

import { normalizeFilePath } from '@utils/core';

import { AgentConfigSchema } from './agentConfig';
import { JsonValueSchema } from './jsonValue';
import { RetryErrorInfoSchema } from './errors';
import { RunOutcomeSchema } from './run';
import { RunUsageTotalsSchema } from './usage';

/**
 * The `run.config` of a run no agent drives, such as a background command or
 * an external CLI's process: what it is called, the instruction it was given,
 * and the directory and model it runs with. Kept strict and first in
 * `RunRecordFieldsSchema` so an agent config's defaults cannot be read into
 * it.
 */
export const NonAgentRunRecordSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  instruction: Schema.String,
  workingDirectory: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});

/** Inputs have already passed launch validation; persisted records are canonical. */
export const RunRecordFieldsSchema = Schema.Union([
  NonAgentRunRecordSchema,
  AgentConfigSchema,
]);

/** Whether the run is a task (an agent carrying a plugin's block, run on
 *  its recipe): its value and its children's spend are its output, its end
 *  its record; it resumes from its checkpoint, its opening rebuilt. */
export const isTaskConfig = (
  config: typeof RunRecordFieldsSchema.Encoded,
): boolean => recipeBlockOf(config) !== null;

/** The block key of the plugin whose recipe the run opened on
 *  (`script.block`), or null for a run that is no task. */
export const recipeBlockOf = (
  config: typeof RunRecordFieldsSchema.Encoded,
): string | null =>
  'script' in config && config.script?.kind === 'recipe'
    ? config.script.block
    : null;

/** Terminal errors keep the classified kind beside the provider detail. */
const RunEndErrorSchema = Schema.Union([
  RetryErrorInfoSchema.mapFields(
    Struct.pick(['message', 'userRetryable', 'partialText']),
  )
    .mapFields(Struct.map(Schema.optional))
    .mapFields(
      Struct.assign({
        kind: Schema.Literals(['abort', 'disk-full', 'result-lost']),
      }),
    ),

  RetryErrorInfoSchema.mapFields(Struct.map(Schema.optional)).mapFields(
    Struct.assign({
      kind: Schema.Literals([
        'context-window',
        'missing-api-key',
        'unexpected',
      ]),
    }),
  ),
]);

/**
 * What a run produced (one run model, section 3.4): the value the flow hands
 * its lifecycle and every result reader returns, stored whole as the
 * `run.end` row ({@link RunEndRowSchema}).
 */
const RunEndOutputSchema = Schema.Struct({
  response: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
  /** Workspace-relative paths of files edited by tool calls during the run. */
  files: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Value captured by the `submit_output` terminal tool, or the value a
   *  recipe's script returned (its plugin's block reads it:
   *  `AgentBlock.result`). */
  structured: Schema.optional(JsonValueSchema),
});
/**
 * The decoded output of a run: its final response text, the workspace files it
 * edited, and the structured value its terminal tool or recipe returned.
 */
export type RunEndOutput = typeof RunEndOutputSchema.Type;

/** The output of a run that ended before its flow produced one. */
export function emptyRunEndOutput(): RunEndOutput {
  return Schema.decodeUnknownSync(RunEndOutputSchema)({});
}

/**
 * A run's terminal result as every reader sees it. `error` is present only
 * on a failed outcome; `usage` once a round recorded usage, including on
 * failures. Cost is `usage.totalCost` and nothing else. Derived on read
 * (`readRunEnd`): the usage is the run history's fold of its priced response
 * rows, the output as {@link RunEndOutputSchema} says.
 */
export const RunEndSchema = Schema.Struct({
  outcome: RunOutcomeSchema,
  error: Schema.optional(RunEndErrorSchema),
  usage: Schema.optional(RunUsageTotalsSchema),
  output: RunEndOutputSchema,
});
/** The decoded shape of {@link RunEndSchema}. */
export type RunEnd = typeof RunEndSchema.Type;

/**
 * The terminal fact, written once per lifecycle as the `run.end` row: the
 * outcome, the classified error and the stored output. Every run's usage is
 * its priced response rows'.
 */
export const RunEndRowSchema = RunEndSchema.mapFields(Struct.omit(['usage']));

/**
 * What a producer recorded beside a run's terminal fact, written as the
 * `run.result` row. It carries only what no other row does: the producer's
 * own context and a subagent's delivered reply (a child loop's `run.end` carries none, by
 * rule, and a child waiting for its next turn has none yet). Outcome, error,
 * usage and a workflow's files are read from their own rows — never copied
 * here (one run model, section 3.3).
 */
export const ResultMetaSchema = Schema.Union([
  Schema.Struct({
    producer: Schema.Literal('backgroundBash'),
    exitCode: Schema.optional(Schema.Int),
    wallTimeMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    success: Schema.Boolean,
    timedOut: Schema.optional(Schema.Boolean),
    command: Schema.String,
  }),
  Schema.Struct({
    producer: Schema.Literal('subagent'),
    output: RunEndOutputSchema,
  }),
]);
/** The decoded shape of {@link ResultMetaSchema}. */
export type ResultMeta = typeof ResultMetaSchema.Type;

/** Canonical workspace paths at the record boundary. */
export const RunWorkspaceFilesSchema = Schema.Array(Schema.String).pipe(
  Schema.decodeTo(Schema.Array(Schema.String), {
    decode: SchemaGetter.transform((paths) =>
      [
        ...new Set(
          paths.map((value) => normalizeFilePath(value.trim())).filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);
