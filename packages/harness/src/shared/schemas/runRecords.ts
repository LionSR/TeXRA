/** Canonical run metadata records, independent of runtime machinery. */
import { Schema, SchemaGetter, Struct } from 'effect';

import { normalizeFilePath } from '@utils/core';

import { AgentConfigSchema } from './agentConfig';
import { RunIdSchema } from './identifiers';
import { JsonValueSchema } from './jsonValue';
import { ModelFailureSchema, modelFailureMessage } from './errors';
import { RunOutcomeSchema } from './run';
import { RunIdentitySchema } from './runIdentity';
import { TokenUsageStatsSchema } from './usage';

export const NonAgentRunRecordSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
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

/**
 * Why a run stops. `user` is an explicit stop of the work (a stop button,
 * Ctrl-C on a running turn, an agent's kill); `released`, the end of the
 * call that awaited a child (its script ended, its batch was cut). Both
 * cancel the remote background operation the run is observing.
 * `shutdown` only ends this process's hold on the run (an exit, a signal, a
 * session close), leaving that operation for a resume to observe.
 */
export const RunStopReasonSchema = Schema.Literals([
  'user',
  'released',
  'shutdown',
]);
/** Why a run stops: a `user` stop, its awaiting call's `released`, or this
 *  process's `shutdown`. */
export type RunStopReason = typeof RunStopReasonSchema.Type;

/** Why a run ended failed: a local failure in its own words, or a model
 *  failure as the run's rows record it, its verdict (`failure`), which each
 *  reader words. */
const RunEndErrorSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(['disk-full', 'result-lost', 'unexpected']),
    message: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('model'),
    failure: ModelFailureSchema,
  }),
]);

/** Why a run ended failed ({@link RunEndErrorSchema}). */
export type RunEndError = typeof RunEndErrorSchema.Type;

/** A run's failure in plain words: a model failure's verdict worded
 *  ({@link modelFailureMessage}), a local one's own words. */
export function runEndErrorMessage(error: RunEndError): string {
  return error.kind === 'model'
    ? modelFailureMessage(error.failure)
    : error.message;
}

/**
 * What a run produced (one run model, section 3.4): the value the flow hands
 * its lifecycle and every result reader returns, stored whole as the
 * `run.end` row ({@link RunEndRowSchema}).
 */
const RunEndOutputSchema = Schema.Struct({
  response: Schema.String,
  /** Workspace-relative paths of files edited by tool calls during the run. */
  files: Schema.Array(Schema.String),
  /** Value captured by the `submit_output` terminal tool, or the value a
   *  recipe's script returned (its plugin's block reads it:
   *  `AgentBlock.result`). */
  structured: Schema.optional(JsonValueSchema),
});
export type RunEndOutput = typeof RunEndOutputSchema.Type;

/** The output of a run that ended before its flow produced one. */
export function emptyRunEndOutput(): RunEndOutput {
  return { response: '', files: [] };
}

/**
 * A run's terminal result as every reader sees it. `error` is present only
 * on a failed outcome; `usage` once a round recorded usage, including on
 * failures. Cost is `usage.cost` and nothing else. Derived on read
 * (`readRunEnd`): the usage is the run history's fold of its priced response
 * rows, the output as {@link RunEndOutputSchema} says.
 */
export const RunEndSchema = Schema.Struct({
  outcome: RunOutcomeSchema,
  error: Schema.optional(RunEndErrorSchema),
  usage: Schema.optional(TokenUsageStatsSchema),
  output: RunEndOutputSchema,
});
export type RunEnd = typeof RunEndSchema.Type;

/**
 * The terminal fact, written once per lifecycle as the `run.end` row: the
 * outcome, the classified error and the stored output. Every run's usage is
 * its priced response rows'.
 */
export const RunEndRowSchema = RunEndSchema.mapFields(Struct.omit(['usage']));

/**
 * How a process run's command exited (the `process.exit` row): its code
 * (null when it had none: it could not start, or died by a signal) and
 * whether the run's own timeout ended it. A run a stop interrupted has
 * none: the interruption is the fact.
 */
export const ProcessExitSchema = Schema.Struct({
  code: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
});
export type ProcessExit = typeof ProcessExitSchema.Type;

/**
 * One run's result as `readResult` answers it: its terminal fact, the
 * terminal fields absent while the run has not ended, and a process run's
 * exit once its command exited.
 */
export const RunResultSchema = RunEndSchema.mapFields(
  Struct.assign({
    outcome: Schema.optional(RunOutcomeSchema),
    exit: Schema.optional(ProcessExitSchema),
  }),
);
/** One run's result as `readResult` answers it. */
export type RunResult = typeof RunResultSchema.Type;

/** A workspace file a run edited, as it stands now. */
export const RunWorkspaceFileSchema = Schema.Struct({
  path: Schema.String,
  size: Schema.Int,
  isDirectory: Schema.Boolean,
});
/** A workspace file a run edited, as it stands now. */
export type RunWorkspaceFile = typeof RunWorkspaceFileSchema.Type;

/**
 * A run a person started themselves, as a history list shows it: an agent
 * run with no parent, with its record. Background processes and scripts
 * (`identity.kind`) and the runs an agent spawned, which belong to their
 * parent's transcript, are not listed; a lookup by explicit id reads the
 * run's records instead.
 */
export const AgentRunListingEntrySchema = Schema.Struct({
  id: RunIdSchema,
  timestamp: Schema.String,
  /** The run's durable outcome (its `run.end`), null while none has landed. */
  outcome: Schema.NullOr(RunOutcomeSchema),
  /** AI-generated summary of what the session aimed to accomplish. */
  description: Schema.optional(Schema.String),
  /** The model the run is on, as the view folds it: its newest
   *  `run.config`'s. */
  model: Schema.optional(Schema.String),
  /** `deriveResumability` finds a point to continue from. Ownership and
   *  loadability are settled when the run is opened. */
  resumable: Schema.Boolean,
  /** Why the run cannot resume in this build although it may have rows to
   *  continue from: they could not be read, an earlier build wrote them, or
   *  they hold a fact of a plugin this process does not load. Absent when
   *  it resumes or simply has nothing to continue from. */
  resumeBlocked: Schema.optional(Schema.String),
  /** What the run is: the durable authority, stamped at registration. */
  identity: RunIdentitySchema.members[0],
  record: AgentConfigSchema,
});
/** A run a person started, as a history list shows it. */
export type AgentRunListingEntry = typeof AgentRunListingEntrySchema.Type;

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
