/**
 * The `theory` plugin's document rows (its `factKinds`, `@tools/plugins`):
 * a document task's documents are its latest `plugin.fact` of kind
 * `theory/output`, which carries every revision's outputs, and the files
 * a run last accepted into the workspace are its `theory/accepted`. Core
 * stores and applies the rows without reading them (`RunView.facts`); this
 * module is their schemas and their one reader, which hosts, webviews and the
 * plugin's own tools share. Browser-safe: it imports only schemas.
 */
import { Schema } from 'effect';

import { factName, type ToolFact } from '@texra-ai/worldline/schemas';
import {
  DocumentDiffsSchema,
  RoundOutputSchema,
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
  type DocumentDiffs,
  type DocumentsResult,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import type { RunView } from '@texra-ai/worldline/schemas';

/** The id of the plugin that owns the document programs, their tools and
 *  their rows. */
const THEORY_PLUGIN = 'theory';

/** The `merge` program's argument naming the partial edit it merges back
 *  into its input: a file argument (`Program.fileArgs`), which the
 *  documents tools read from the run's program arguments. */
export const MERGE_EDITED_FILE = 'editedFile';

/** What a document program told its first `document_context` call about
 *  itself, which its later steps read back. */
const DocumentTaskSpecSchema = Schema.Struct({
  /** What every revision's prompt opens with, before the documents. */
  intro: Schema.String,
  /** What each revision is asked, in order: one revision per request. */
  requests: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  /** The plugin's template files its revisions read, by name. */
  templates: Schema.Array(Schema.String),
  /** It writes new documents (a deck, a transcript) and not rewrites of
   *  its inputs: its outputs descend from no input. */
  creates: Schema.Boolean,
});
/** A document program's own facts, as its first step recorded them. */
export type DocumentTaskSpec = typeof DocumentTaskSpecSchema.Type;

const DocumentsOutputSchema = Schema.Struct({
  /** The program, as its first step recorded it. */
  task: DocumentTaskSpecSchema,
  /** Every revision so far, by its zero-based `round`. */
  rounds: Schema.Array(RoundOutputSchema),
  /** The proposed revision's diffs, once the task proposed: the one record
   *  of them, which its run's result is derived from. Optional: a row
   *  written before the task proposed holds none. */
  ...DocumentDiffsSchema.fields,
});
/** A document task's documents, as its latest documents row holds them. */
export type DocumentsOutput = typeof DocumentsOutputSchema.Type;

/** The theory plugin's one row kind. */
export const DOCUMENTS_OUTPUT_KIND = Object.freeze({
  plugin: THEORY_PLUGIN,
  kind: 'output',
  version: 1,
  schema: DocumentsOutputSchema,
  // A document task runs a program, which is never forked.
  fork: 'drop',
} as const);

/** The key a run's documents are kept under in `RunView.facts`. */
const DOCUMENTS_OUTPUT_KEY = factName(DOCUMENTS_OUTPUT_KIND);

/** The fact that makes `rounds` (and, once proposed, the final `diffs`)
 *  the documents of the calling run of `task`, for its call's result
 *  (`ToolResult.facts`). */
export function documentsOutputFact(
  task: DocumentTaskSpec,
  rounds: readonly RoundOutput[],
  diffs: DocumentDiffs = {},
): ToolFact {
  return {
    plugin: DOCUMENTS_OUTPUT_KIND.plugin,
    kind: DOCUMENTS_OUTPUT_KIND.kind,
    version: DOCUMENTS_OUTPUT_KIND.version,
    value: Schema.decodeUnknownSync(DocumentsOutputSchema)({
      task,
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
export const DOCUMENTS_ACCEPTED_KIND = Object.freeze({
  plugin: THEORY_PLUGIN,
  kind: 'accepted',
  version: 1,
  schema: DocumentsAcceptedSchema,
  // The source wrote those files; a fork wrote none.
  fork: 'drop',
  writes: (value: unknown): readonly string[] =>
    Schema.decodeUnknownSync(DocumentsAcceptedSchema)(value).absolutePaths,
} as const);

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

/** A run's documents row, decoded; undefined for a run that recorded
 *  none. */
const documentsRowOf = (
  run: Pick<RunView, 'facts'>,
): DocumentsOutput | undefined => {
  const value = run.facts[DOCUMENTS_OUTPUT_KEY];
  return value === undefined
    ? undefined
    : Schema.decodeUnknownSync(DocumentsOutputSchema)(value);
};

/** A run's documents rounds, from its latest documents row; none for a
 *  run that recorded none. */
export const documentRoundsOf = (
  run: Pick<RunView, 'facts'>,
): readonly RoundOutput[] => documentsRowOf(run)?.rounds ?? [];

/** How many revisions a document task runs, once its first step recorded
 *  it. */
export const documentRevisionsOf = (
  run: Pick<RunView, 'facts'>,
): number | undefined => documentsRowOf(run)?.task.requests.length;

/** What a document task reports of its documents: every revision's
 *  outputs and compile failures, and the proposed diffs. A projection of
 *  the documents row, built where it is read and never stored. */
export function documentsSummary({
  rounds,
  diffs = [],
  diffsUnavailable,
}: DocumentsOutput): DocumentsResult {
  return {
    outputs: roundOutputsToOutputSummaries(rounds),
    compileFailures: roundOutputsToCompileFailureSummaries(rounds),
    diffs,
    ...(diffsUnavailable === undefined ? {} : { diffsUnavailable }),
  };
}

/** What a run reports of its documents ({@link documentsSummary}); none
 *  for a run that recorded no documents row. */
export function documentsOf(
  run: Pick<RunView, 'facts'>,
): DocumentsResult | undefined {
  const row = documentsRowOf(run);
  return row === undefined ? undefined : documentsSummary(row);
}

/** Whether `run` is a document task: a program's run that works on
 *  documents with this plugin's tools. Its documents row says so, whatever
 *  program it opened on, so a program a model wrote reads the same; the
 *  run's first step writes the row. */
export const isDocumentTaskRun = (run: Pick<RunView, 'facts'>): boolean =>
  DOCUMENTS_OUTPUT_KEY in run.facts;
