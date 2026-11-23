/** Canonical run metadata records, independent of runtime machinery. */
import { Schema, SchemaGetter, Struct } from 'effect';

import { normalizeFilePath } from '@utils/core/pathBasics';
import type { ExecEnd } from '@utils/system/execUtils';

import { AgentConfigSchema, type AgentConfig } from './agentConfig';
import { RunIdSchema } from './identifiers';
import { ModelFailureSchema, modelFailureMessage } from './errors';
import { RunOutcomeSchema } from './run';
import { RunIdentitySchema } from './runIdentity';
import { TokenUsageStatsSchema } from './usage';

const NonAgentRunRecordSchema = Schema.Struct({
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

/**
 * The canonical run configuration (`RunRecordFieldsSchema`, the `run.config`
 * row's field): a real `AgentConfig` for agent runs, the honest minimal
 * record for everything else. The union keeps the strict non-agent arm
 * first: the agent arm's decoding defaults would fabricate an agent config
 * out of any object.
 */
export type RunRecord = typeof RunRecordFieldsSchema.Type;

/** The key only an agent config carries (the strict non-agent arm cannot). Typed
 *  so a rename on either arm fails to compile instead of silently matching
 *  none. */
const AGENT_RECORD_KEY: Exclude<
  keyof AgentConfig,
  keyof typeof NonAgentRunRecordSchema.Type
> = 'label';

/** Whether `record` is an agent run's config. */
export function isAgentRunRecord(record: RunRecord): record is AgentConfig {
  return AGENT_RECORD_KEY in record;
}

/**
 * Per-category config-field exclusions: a conversation (`agent`) hides the
 * task's file fields, a `task` hides its program's source. Unknown
 * categories get no filtering.
 */
const HIDDEN_CONFIG_FIELDS_BY_CATEGORY: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  agent: new Set(['inputFiles', 'contextFiles', 'outputFiles']),
  task: new Set(['script']),
};

/**
 * Serialize a run record to pretty JSON for `/executions/{id}/config`,
 * dropping agent-config fields irrelevant to the resolved display category
 * so the serialized config the orchestrator reads stays relevant. Records
 * without an agent execution mode are honest by construction and serialize
 * unchanged.
 */
export function serializeFilteredConfig(
  record: RunRecord,
  category: string | undefined,
): string {
  const excludeSet = category
    ? HIDDEN_CONFIG_FIELDS_BY_CATEGORY[category]
    : undefined;
  if (!excludeSet) {
    return JSON.stringify(record, null, 2);
  }
  const filtered = Object.fromEntries(
    Object.entries(record).filter(([key]) => !excludeSet.has(key)),
  );
  return JSON.stringify(filtered, null, 2);
}

/** Whether the run is a script's (`config.script`, a background script or a
 *  program): its one response is its script call. It renders no prompt and
 *  activates no skill, ends when that call does (no later turn, and its
 *  `Stop` hook runs as already active), and is no conversation to fork or
 *  start a goal from. */
export const runsScript = (config: Pick<AgentConfig, 'script'>): boolean =>
  config.script != null;

/** A script a parent sent to the background, the one script its run is,
 *  or null for any other run. Its end is delivered to the conversation that
 *  launched it as a script's delivery, not a subagent's report, and its
 *  `self()` is that conversation as the script found it. */
export const backgroundScriptOf = (
  config: Pick<AgentConfig, 'script'>,
): Extract<AgentConfig['script'], { kind: 'background' }> | null =>
  config.script?.kind === 'background' ? config.script : null;

/** The registered program the run opened on (its `name` and `args`), or
 *  null for any other run. A program's run is a script that ends: its
 *  value and its children's spend are its output, its end its record, and
 *  it takes no later message. What its launch grants it (its tools, the
 *  runs it starts, the files it hands them) follows from where the program
 *  comes from ({@link programOrigin}). */
export const programOf = (
  config: Pick<AgentConfig, 'script'> | typeof RunRecordFieldsSchema.Encoded,
): Extract<AgentConfig['script'], { kind: 'program' }> | null =>
  'script' in config && config.script?.kind === 'program'
    ? config.script
    : null;

/** What the name of a program an agent wrote for itself begins with,
 *  before the colon (`own:<name>`, a file in its memory). No installed
 *  plugin takes it for its name. */
export const OWN_PROGRAM_PREFIX = 'own';

/** Where a program comes from ({@link programOrigin}). */
export type ProgramOrigin = 'listed' | 'installed' | 'own';

/**
 * Where the program `name` comes from, which decides what its launch
 * grants its run:
 *
 * | origin      | name              | its tools            | what it starts         | a child's prompt, files |
 * | ----------- | ----------------- | -------------------- | ---------------------- | ----------------------- |
 * | `listed`    | `<name>`          | fixed past switches  | approved by its launch | passed as written       |
 * | `installed` | `<plugin>:<name>` | through the switches | approved by the review | handed off, resolved    |
 * | `own`       | `own:<name>`      | through the switches | asked about            | handed off, resolved    |
 *
 * A `listed` program is one the app's plugin list registers: the app wrote
 * it. An `installed` one is read from an installed plugin's file, whose
 * programs a person reviewed when they enabled it, but whose text is not
 * the app's: its tools pass the user's switches, the prompt a child gets
 * is handed off with the caller's instruction, and the files it hands that
 * child are resolved as a model's script's are. An `own` one is a file the
 * agent wrote into its memory, which nobody reviewed: beside that, what it
 * starts is asked about under the approval policy as a model's own
 * script's is, and where no prompt can show, the tools that ask are
 * withheld from it.
 */
export const programOrigin = (name: string): ProgramOrigin => {
  if (name.startsWith(`${OWN_PROGRAM_PREFIX}:`)) return 'own';
  return name.includes(':') ? 'installed' : 'listed';
};

/**
 * Why a run stops. `user` is an explicit stop of the work (a stop button,
 * Ctrl-C on a running turn, an agent's kill); `released`, the end of the
 * call that awaited a child (its script ended, its batch was cut); `cap`,
 * the spend cap the run or a run above it was started with, reached. All
 * cancel the remote background operation the run is observing. A process
 * that exits stops nothing: its runs are left as their rows stand, with no
 * stop and no end, and read as interrupted at the next open.
 */
export const RunStopReasonSchema = Schema.Literals(['user', 'released', 'cap']);
/** Why a run stops: a `user` stop, its awaiting call's `released`, or a
 *  spend `cap` reached. */
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
 * What a run produced: the value the flow hands
 * its lifecycle and every result reader returns, stored whole as the
 * `run.end` row ({@link RunEndRowSchema}).
 */
const RunEndOutputSchema = Schema.Struct({
  response: Schema.String,
  /** Workspace-relative paths of files edited by tool calls during the run. */
  files: Schema.Array(Schema.String),
  /** Value captured by the `submit_output` terminal tool, or the value a
   *  program's script returned. */
  structured: Schema.optional(Schema.Json),
});
export type RunEndOutput = typeof RunEndOutputSchema.Type;

/** The output of a run that ended before its flow produced one. */
export function emptyRunEndOutput(): RunEndOutput {
  return { response: '', files: [] };
}

/**
 * A run's terminal result as every reader sees it. `error` is present on a
 * failed outcome, and on a cancelled one whose stop cut a failure short;
 * `usage` once a round recorded usage, including on failures. Cost is `usage.cost` and nothing else. Derived on read
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
 * How a process run's command exited (the `process.exit` row, and a
 * background command's delivery to its parent): its code, null when it had
 * none (it timed out, could not start, or died by a signal), and whether the
 * run's own timeout ended it. A run a stop interrupted has none: the
 * interruption is the fact.
 */
export const ProcessExitSchema = Schema.Struct({
  code: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
});
export type ProcessExit = typeof ProcessExitSchema.Type;

/** How a command's `end` is recorded: only an exit has a code. */
export const processExit = (end: ExecEnd): ProcessExit => ({
  code: end._tag === 'Exited' ? end.code : null,
  timedOut: end._tag === 'TimedOut',
});

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
  /** Whether the run continues in this process (`deriveContinuation`),
   *  whatever its outcome: `continues` for a finished conversation, which
   *  takes another message, as for an interrupted run; `finished` for a
   *  program whose result is in; `blocked` with why its rows cannot be
   *  continued in this build (they could not be read, an earlier build
   *  wrote them, or they hold a fact of a plugin this process does not
   *  load). Ownership and loadability are decided when the run is opened. */
  continuation: Schema.Union([
    Schema.Struct({ kind: Schema.Literals(['continues', 'finished']) }),
    Schema.Struct({ kind: Schema.Literal('blocked'), cause: Schema.String }),
  ]),
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
      ].toSorted((a, b) => a.localeCompare(b)),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);
