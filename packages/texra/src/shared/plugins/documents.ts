/**
 * The documents plugin's rows (its `factKinds`, `@tools/plugins`): a
 * document task's documents are its latest `plugin.fact` of kind
 * `documents/output`, which carries every revision's outputs, and the files
 * a run last accepted into the workspace are its `documents/accepted`. Core
 * stores and applies the rows without reading them (`RunView.facts`); this
 * module is their schemas and their one reader, which hosts, webviews and the
 * plugin's own tools share. It also holds the `task:` block of an agent
 * file the plugin owns (`DOCUMENT_TASK_BLOCK`), which the catalog scans
 * with. Browser-safe: it imports only schemas.
 */
import { Effect, Record as Rec, Result, Schema, Struct } from 'effect';

import { type ToolFact } from '@texra-ai/harness/schemas';
import {
  DocumentDiffsSchema,
  RoundOutputSchema,
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
  type DocumentDiffs,
  type DocumentsResult,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import { AgentOptionDataSchema } from '@texra/shared/pickerOptions';
import type { RunView, AgentConfig } from '@texra-ai/harness/schemas';
import type { AgentBlock } from '@texra-ai/harness/plugins';

const DocumentsOutputSchema = Schema.Struct({
  /** Every revision so far, by its zero-based `round`. */
  rounds: Schema.Array(RoundOutputSchema),
  /** The proposed revision's diffs, once the task proposed: the one record
   *  of them, which its run's result is derived from. Optional: a row
   *  written before the task proposed holds none. */
  ...DocumentDiffsSchema.fields,
});

/** The documents plugin's one row kind. */
export const DOCUMENTS_OUTPUT_KIND = {
  plugin: 'documents',
  kind: 'output',
  // v2: a proposed task's fact carries its `diffs`. v3: each round holds
  // its `latexdiffs` and its `reply`, which were log rows. v4: a round's
  // compile check is its `compile` outcome, an output's lineage is its
  // `base` and `document`, and a latexdiff records its math markup. An
  // earlier version is an earlier build's row, and an earlier build reads a
  // v4 one as a newer build's.
  version: 4,
  schema: DocumentsOutputSchema,
  // A document task runs a recipe script, which is never forked.
  fork: 'drop',
} as const;

/** The key a run's documents are kept under in `RunView.facts`. */
const DOCUMENTS_OUTPUT_KEY = `${DOCUMENTS_OUTPUT_KIND.plugin}/${DOCUMENTS_OUTPUT_KIND.kind}`;

/** The fact that makes `rounds` (and, once proposed, the final `diffs`)
 *  the calling run's documents, for its call's result (`ToolResult.facts`). */
export function documentsOutputFact(
  rounds: readonly RoundOutput[],
  diffs: DocumentDiffs = {},
): ToolFact {
  return {
    plugin: DOCUMENTS_OUTPUT_KIND.plugin,
    kind: DOCUMENTS_OUTPUT_KIND.kind,
    version: DOCUMENTS_OUTPUT_KIND.version,
    value: Schema.decodeUnknownSync(DocumentsOutputSchema)({
      rounds,
      ...diffs,
    }),
  };
}

const DocumentsAcceptedSchema = Schema.Struct({
  /** The workspace files the acceptance wrote. */
  absolutePaths: Schema.Array(Schema.String),
  /** When it wrote them, so a second acceptance of the same files is new. */
  acceptedAt: Schema.Number,
});

/** The files a run last accepted into the workspace, past the editor's own
 *  write path: what every process that applies the run announces
 *  (`workspaceFilesWritten`). */
export const DOCUMENTS_ACCEPTED_KIND = {
  plugin: 'documents',
  kind: 'accepted',
  version: 1,
  schema: DocumentsAcceptedSchema,
  // The source wrote those files; a fork wrote none.
  fork: 'drop',
  writes: (value: unknown): readonly string[] =>
    Schema.decodeUnknownSync(DocumentsAcceptedSchema)(value).absolutePaths,
} as const;

/** The fact that the calling run accepted `absolutePaths` at
 *  `acceptedAt`, for its call's result (`ToolResult.facts`). */
export function documentsAcceptedFact(
  absolutePaths: readonly string[],
  acceptedAt: number,
): ToolFact {
  return {
    plugin: DOCUMENTS_ACCEPTED_KIND.plugin,
    kind: DOCUMENTS_ACCEPTED_KIND.kind,
    version: DOCUMENTS_ACCEPTED_KIND.version,
    value: Schema.decodeUnknownSync(DocumentsAcceptedSchema)({
      absolutePaths: [...absolutePaths],
      acceptedAt,
    }),
  };
}

/** A run's documents rounds, from its latest documents row; none for a
 *  run that recorded none. */
export function documentRoundsOf(
  run: Pick<RunView, 'facts'>,
): readonly RoundOutput[] {
  const value = run.facts[DOCUMENTS_OUTPUT_KEY];
  return value === undefined
    ? []
    : Schema.decodeUnknownSync(DocumentsOutputSchema)(value).rounds;
}

/** The documents a run's end reports of its documents fact: every
 *  revision's outputs and compile failures, and the proposed diffs. */
export function documentsSummary(fact: ToolFact): DocumentsResult {
  const {
    rounds,
    diffs = [],
    diffsUnavailable,
  } = Schema.decodeUnknownSync(DocumentsOutputSchema)(fact.value);
  return {
    outputs: roundOutputsToOutputSummaries(rounds),
    compileFailures: roundOutputsToCompileFailureSummaries(rounds),
    diffs,
    ...(diffsUnavailable === undefined ? {} : { diffsUnavailable }),
  };
}

/**
 * A document task: what the documents recipe runs over its persona. Each
 * request (Nunjucks) opens one revision, in order, after the `prefix` that
 * lays out the documents; `outputs` are the files a task writes when the
 * launch names none, and `files` binds template variables to files beside
 * the YAML (`X` renders as `X_FILE` and `X_CONTENT`).
 */
const DocumentTaskSchema = Schema.Struct({
  outputs: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  files: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  prefix: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
  requests: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
});
/** A document task with its defaults applied. */
export type DocumentTask = typeof DocumentTaskSchema.Type;

/** The `task:` block of an agent file, owned by the documents plugin. */
export const DOCUMENT_TASK_BLOCK: AgentBlock<DocumentTask> = Object.freeze({
  key: 'task',
  schema: DocumentTaskSchema,
});

/** Whether `run` is a document task: opened on this plugin's recipe, not
 *  on another plugin's. */
export const isDocumentTaskRun = (run: Pick<RunView, 'recipe'>): boolean =>
  run.recipe === DOCUMENT_TASK_BLOCK.key;

/** An agent option as every launcher lists it: one that is also a document
 *  task carries its revision count (the header's "Pass 2 of 3"). */
export const DocumentAgentOptionSchema = AgentOptionDataSchema.mapFields(
  Struct.assign({
    rounds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
);
export type DocumentAgentOption = typeof DocumentAgentOptionSchema.Type;

/**
 * The switches a document task's launch may set, under the key its run's
 * `script.options` stores them by and its approval shows them
 * (`AgentProposal.options`). The launch form's menu items, the
 * `document_task` tool's fields and `texra run`'s flags render from this
 * table; `menu` is the launch form's file group whose header menu offers
 * the switch.
 */
export const DOCUMENT_TASK_OPTIONS = Object.freeze({
  attachTeXCount: Object.freeze({
    label: 'Attach TeX Count',
    description:
      "Add each input document's texcount statistics to the prompt, so the agent knows its size and structure.",
    menu: 'input',
  }),
  reflect: Object.freeze({
    label: 'Critic review',
    description:
      'Have the `critic` agent review each revision but the last; the next revision reads its critique.',
    menu: 'input',
  }),
  autoExtractFigure: Object.freeze({
    label: 'Figures',
    description: 'Attach the figures the input LaTeX includes as media.',
    menu: 'media',
  }),
  autoExtractTikzFigure: Object.freeze({
    label: 'TikZ Figures',
    description: 'Compile the input LaTeX TikZ figures and attach them.',
    menu: 'media',
  }),
  autoCompileInputPdf: Object.freeze({
    label: 'Compile Input PDF',
    description: 'Compile each input LaTeX file and attach its PDF.',
    menu: 'media',
  }),
} satisfies Record<
  string,
  {
    readonly label: string;
    readonly description: string;
    readonly menu: 'input' | 'media';
  }
>);

/** The switches as a run stores them, each off unless the launch set it. */
export const DocumentTaskOptionsSchema = Schema.Struct(
  Rec.map(DOCUMENT_TASK_OPTIONS, () =>
    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  ),
);
/** A document task's launch options with their defaults applied. */
export type DocumentTaskOptions = typeof DocumentTaskOptionsSchema.Type;

/** The options a document task's run was launched with: its recipe's
 *  `script.options`, defaults for any it does not name. */
export const documentTaskOptions = (
  config: Pick<AgentConfig, 'script'>,
): DocumentTaskOptions =>
  Schema.decodeUnknownSync(DocumentTaskOptionsSchema)(
    config.script?.kind === 'recipe' ? config.script.options : {},
  );

/** What a proposal launches, as its approval copy names it. */
export function agentProposalLabel(proposal: {
  readonly task: boolean;
  readonly options?: Readonly<Record<string, unknown>> | null;
}): string {
  if (!proposal.task) return 'agent';
  // A reflecting task also runs a critic after every revision but the last;
  // options this plugin cannot read name no critic.
  const options = Schema.decodeUnknownResult(DocumentTaskOptionsSchema)(
    proposal.options ?? {},
  );
  return Result.isSuccess(options) && options.success.reflect
    ? 'document task, with critic'
    : 'document task';
}
