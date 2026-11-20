/**
 * Contract for the CLI's `--output-format ndjson` line records.
 *
 * Every headless command emits one JSON object per line, tagged with a
 * `kind`. A result kind of {@link CLI_RESULT_FIELD} carries its payload
 * under one field the kind fixes; the kinds of {@link CliSpreadKind} spread
 * their payload at the top level; `version`, `agent-result` and `result`
 * carry a typed field. `writeNdjsonStdout` appends the line's `ts` and its
 * {@link CLI_NDJSON_CONTRACT} after the record's own keys, so `kind` stays
 * first. {@link CliNdjsonRecord} is derived from these lists, so a typo'd or
 * unregistered `kind` fails to compile.
 */

// Third-party imports
import { Schema, Struct } from 'effect';

import {
  InstalledPluginSchema,
  RunEndSchema,
  RunIdSchema,
} from '@texra-ai/harness/schemas';
import { DocumentsResultSchema } from '@texra/shared/plugins/documentOutputs';

/**
 * The CLI output contract version, stamped on every NDJSON line as
 * `contract` (`version` is the `texra version` record's own field). Version 3
 * is 1.0's: `kind: "progress"` records carry a session row verbatim (`event`
 * is the row's `type`, `payload` the rest of it) and results carry `runId`.
 * Version 3 has no stage for a run, a turn or a script (read `run.activate`,
 * `run.position` and `run.end`; a script's calls are the cards whose
 * `stageId` is its card), and no `stage.end` a run's end wrote for a stage it
 * left open.
 */
export const CLI_NDJSON_CONTRACT = 3;

/**
 * An installed plugin as a run result names it: where it came from and, for
 * a fetched plugin, the commit it is pinned to.
 */
const CliPluginPinSchema = InstalledPluginSchema.mapFields(
  Struct.pick(['name', 'source', 'ref', 'commit']),
);
export type CliPluginPin = typeof CliPluginPinSchema.Type;

/**
 * A run's result: its stored end named by its run, with the plugins
 * installed when this invocation started or resumed it (the tools each step
 * offered are the run's `tools.offered` rows) and the folder it ran in.
 */
const CliRunResultSchema = RunEndSchema.mapFields(
  Struct.assign({
    runId: RunIdSchema,
    plugins: Schema.optional(Schema.Array(CliPluginPinSchema)),
    workingDirectory: Schema.optional(Schema.String),
  }),
);
export type CliRunResult = typeof CliRunResultSchema.Type;

/**
 * A document task's result: its output carries its documents (what its
 * documents row reports, in place of a `structured` value), with the run's storage folder
 * and where `--output` or `--output-dir` copied the outputs.
 */
const CliDocumentTaskResultSchema = CliRunResultSchema.mapFields(
  Struct.assign({
    output: RunEndSchema.fields.output
      .mapFields(Struct.omit(['structured']))
      .mapFields(Struct.assign({ documents: DocumentsResultSchema })),
    runDirectory: Schema.String,
    copiedOutput: Schema.optional(Schema.String),
    copiedOutputs: Schema.optional(Schema.Array(Schema.String)),
  }),
);
export type CliDocumentTaskResult = typeof CliDocumentTaskResultSchema.Type;

/** A command's result that is not a run's (`plugin`, `clone`): named by
 *  its command, its fields the command's own. */
interface CliCommandResult {
  readonly command: string;
  readonly [field: string]: unknown;
}

/** The field each one-field result kind carries its payload under: an NDJSON
 *  line is `{ kind, [field]: payload }`, one per element of a list. */
export const CLI_RESULT_FIELD = Object.freeze({
  agent: 'agent',
  'agent-copy': 'copy',
  'workspace-agents': 'agents',
  config: 'config',
  service: 'service',
  task: 'task',
  model: 'model',
  'model-catalog': 'model',
  'models-enabled': 'models',
  'model-enabled': 'model',
  memory: 'memory',
  'init-config': 'init',
  'history-entry': 'entry',
  'history-detail': 'detail',
  'history-delete': 'result',
  skill: 'skill',
  'skill-issue': 'issue',
  plugin: 'plugin',
} as const);

/** A kind whose payload sits under its {@link CLI_RESULT_FIELD} field. */
export type CliResultKind = keyof typeof CLI_RESULT_FIELD;

/** The kinds whose payload is spread at the top level of the line. */
type CliSpreadKind =
  | 'memory-detail'
  | 'chatgpt-auth'
  | 'chatgpt-auth-status'
  | 'grok-auth'
  | 'grok-auth-status'
  | 'doctor-check'
  | 'doctor-summary'
  | 'progress'
  | 'log';

type CliFieldRecord = {
  [K in CliResultKind]: { readonly kind: K } & {
    readonly [F in (typeof CLI_RESULT_FIELD)[K]]: unknown;
  };
}[CliResultKind];

/** A single `--output-format ndjson` line record, before its stamp. */
export type CliNdjsonRecord =
  | CliFieldRecord
  | { readonly kind: CliSpreadKind; readonly [field: string]: unknown }
  | { readonly kind: 'version'; readonly version: string }
  | { readonly kind: 'agent-result'; readonly result: CliRunResult }
  | {
      readonly kind: 'result';
      readonly result: CliDocumentTaskResult | CliCommandResult;
    };
