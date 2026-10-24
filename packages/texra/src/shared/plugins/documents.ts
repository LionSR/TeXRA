/**
 * The documents plugin's rows (its `arms`, `@tools/plugins`): a
 * document task's documents are its latest `plugin.fact` of kind
 * `documents/output`, which carries every revision's outputs, and the files
 * a run last accepted into the workspace are its `documents/accepted`. Core
 * stores and folds the rows without reading them (`RunView.facts`); this
 * module is their schemas and their one reader, which hosts, webviews and the
 * plugin's own tools share. It also holds the `task:` block of an agent
 * file the plugin owns (`DOCUMENT_TASK_BLOCK`), which the catalog scans
 * with. Browser-safe: it imports only schemas.
 */
import { Effect, Schema, Struct } from 'effect';

import {
  AgentOptionDataSchema,
  type FileLocation,
  type SessionEvent,
  type ToolFact,
} from '@texra-ai/harness/schemas';
import {
  DocumentDiffsSchema,
  DocumentsResultSchema,
  RoundOutputSchema,
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
  type DocumentDiffs,
  type CompileFailure,
  type DocumentsResult,
  type LatexdiffEntry,
  type OutputFileInfo,
  type ReadonlyRoundIndexed,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import type { AggregateId } from '@texra-ai/harness';
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
export const DOCUMENTS_OUTPUT_ARM = {
  plugin: 'documents',
  kind: 'output',
  // v2: a proposed task's fact carries its `diffs`. v3: each round holds
  // its `latexdiffs` and its `reply`, which were log rows. No upcaster: an
  // earlier version is an earlier build's row (`pluginFactFloor`), and an
  // earlier build reads a v3 one as a newer build's.
  version: 3,
  schema: DocumentsOutputSchema,
  upcasters: [],
} as const;

/** The key a run's documents fold under in `RunView.facts`. */
export const DOCUMENTS_OUTPUT_KEY = `${DOCUMENTS_OUTPUT_ARM.plugin}/${DOCUMENTS_OUTPUT_ARM.kind}`;

/** The fact that makes `rounds` (and, once proposed, the final `diffs`)
 *  the calling run's documents, for its call's result (`ToolResult.facts`). */
export function documentsOutputFact(
  rounds: readonly RoundOutput[],
  diffs: DocumentDiffs = {},
): ToolFact {
  return {
    plugin: DOCUMENTS_OUTPUT_ARM.plugin,
    kind: DOCUMENTS_OUTPUT_ARM.kind,
    version: DOCUMENTS_OUTPUT_ARM.version,
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
 *  write path: what every process that folds the run announces
 *  (`workspaceFilesWritten`). */
export const DOCUMENTS_ACCEPTED_ARM = {
  plugin: 'documents',
  kind: 'accepted',
  version: 1,
  schema: DocumentsAcceptedSchema,
  upcasters: [],
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
    plugin: DOCUMENTS_ACCEPTED_ARM.plugin,
    kind: DOCUMENTS_ACCEPTED_ARM.kind,
    version: DOCUMENTS_ACCEPTED_ARM.version,
    value: Schema.decodeUnknownSync(DocumentsAcceptedSchema)({
      absolutePaths: [...absolutePaths],
      acceptedAt,
    }),
  };
}

/** A stored documents row's rounds; none for a value that is not one. */
export function documentRoundsOf(value: unknown): RoundOutput[] {
  return value === undefined
    ? []
    : Schema.decodeUnknownSync(DocumentsOutputSchema)(value).rounds;
}

/** The rounds of the latest documents row of `aggregate` among `rows`;
 *  undefined when it wrote none. */
export function latestDocumentRounds(
  rows: readonly SessionEvent[],
  aggregate: AggregateId,
): RoundOutput[] | undefined {
  const row = rows.findLast(
    (event) =>
      event.aggregateId === aggregate &&
      event.type === 'plugin.fact' &&
      `${event.plugin}/${event.kind}` === DOCUMENTS_OUTPUT_KEY,
  );
  return row?.type === 'plugin.fact' ? documentRoundsOf(row.value) : undefined;
}

/** The documents a run's end reports of its documents fact: every
 *  revision's outputs and compile failures, and the proposed diffs. */
export function documentsSummary(fact: ToolFact): DocumentsResult {
  const { rounds, ...diffs } = Schema.decodeUnknownSync(DocumentsOutputSchema)(
    fact.value,
  );
  return Schema.decodeUnknownSync(DocumentsResultSchema)({
    outputs: roundOutputsToOutputSummaries(rounds),
    compileFailures: roundOutputsToCompileFailureSummaries(rounds),
    ...diffs,
  });
}

/** The run's documents by round, from its latest documents row; empty for a
 *  run that is no document task. */
export function documentsOf(run: Pick<RunView, 'facts'>): {
  readonly files: ReadonlyRoundIndexed<OutputFileInfo>;
  readonly missingOutputs: ReadonlyRoundIndexed<string>;
  readonly compileFailures: ReadonlyRoundIndexed<CompileFailure>;
  readonly latexdiffs: ReadonlyRoundIndexed<LatexdiffEntry>;
  /** Each round's kept reply, for a round that wrote nothing or lacks
   *  documents. */
  readonly replies: { readonly [round: number]: FileLocation };
} {
  const rounds = documentRoundsOf(run.facts[DOCUMENTS_OUTPUT_KEY]);
  const byRound = <T>(pick: (round: RoundOutput) => readonly T[]) =>
    Object.fromEntries(
      rounds.flatMap((round) =>
        pick(round).length === 0 ? [] : [[round.round, [...pick(round)]]],
      ),
    );
  return {
    files: byRound((round) => round.outputs),
    missingOutputs: byRound((round) => round.missingOutputs),
    compileFailures: byRound((round) => round.compileFailures),
    latexdiffs: byRound((round) => round.latexdiffs),
    replies: Object.fromEntries(
      rounds.flatMap((round) =>
        round.reply ? [[round.round, round.reply]] : [],
      ),
    ),
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
  /** Edits existing documents (diffed against them), rather than writing
   *  new ones. */
  rewrite: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
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
 * A document task's launch options, as its recipe's run records them
 * (`script.options`) and its approval shows them (`AgentProposal.options`):
 * the figure, TeXCount and compile switches and the critic review. The main
 * view's launch composer offers the same switches (`LaunchSurfaceSchema`).
 */
export const DocumentTaskOptionsSchema = Schema.Struct({
  autoExtractFigure: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  autoExtractTikzFigure: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  attachTeXCount: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  autoCompileInputPdf: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /** A task reviews each revision but the last with the bundled `critic`
   *  and feeds its critique into the next revision. */
  reflect: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
});
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
  return Schema.decodeUnknownResult(DocumentTaskOptionsSchema)(
    proposal.options ?? {},
  ).data.reflect
    ? 'document task, with critic'
    : 'document task';
}
