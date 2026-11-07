/**
 * The documents plugin's output vocabulary: what a document task's revisions
 * wrote (`RoundOutput`, with their compile failures), the flattened
 * summaries its run's result reports (`DocumentsResult`, the recipe's return
 * value and its run's `output.structured`, with the proposed revision's diffs),
 * the output protocol's tags, and how hosts name and label an output. The
 * harness holds none of it. Browser-safe: it imports only schemas and
 * browser-safe path helpers.
 */
import { Result, Schema, Struct } from 'effect';
import {
  getBasename,
  DiffStatsSchema,
  FileLocationSchema,
  fileLocationDisplayPath,
  fileLocationShortDisplayPath,
  LineCountSchema,
  type DiffStats,
} from '@texra-ai/harness/schemas';
import { LATEXDIFF_MATH_MARKUP_VALUES } from '@texra/shared/constants/latexConfig';

/** A zero-based round (a document task's revision) number. */
const RoundNumberSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** What an output revises: the file it is diffed against, as the run holds
 *  it (the pre-run snapshot of a workspace document), and the workspace
 *  document that is, which the user compares with and accepts into; none
 *  when the base names no workspace document. */
const FileLineageSchema = Schema.Struct({
  base: FileLocationSchema,
  document: Schema.NullOr(FileLocationSchema),
});

/** A file a document task wrote, with its lineage (null for a new document)
 *  and diff stats. */
const OutputFileInfoSchema = Schema.Struct({
  source: Schema.String,
  location: FileLocationSchema,
  round: RoundNumberSchema,
  lineage: Schema.NullOr(FileLineageSchema),
  diff: Schema.NullOr(DiffStatsSchema),
});
export type OutputFileInfo = typeof OutputFileInfoSchema.Type;

// The output protocol: every agent wraps its documents in
// `<documents><document name="...">...</document></documents>`, after its
// thinking in `<scratchpad>`. Fixed constants, not per-agent configuration.

/** Outer container tag wrapping every document the model emits. */
export const OUTPUT_DOCUMENTS_TAG = 'documents';

/** Per-document child tag inside the container, carrying a `name` attribute. */
export const OUTPUT_DOCUMENT_TAG = 'document';

/** Closing tag that marks a complete response. */
export const OUTPUT_END_TAG = `</${OUTPUT_DOCUMENTS_TAG}>`;

/** The tag a model wraps its thinking in, before the documents container. */
export const SCRATCHPAD_TAG = 'scratchpad';

/** A round's label: `Revision 2`. A zero-based round renders one-based. */
export function formatRoundLabel(round: number): string {
  return `Revision ${round + 1}`;
}

// Generic raw-wrapper stems are run-storage internals, not the meaningful
// document name, so they must never surface as an artifact's name.
const GENERIC_OUTPUT_STEMS = new Set(['output', 'output.xml', 'output.tex']);

/** Whether a document name is a generic raw-wrapper stem rather than a name. */
export function isGenericOutputStem(name: string): boolean {
  return GENERIC_OUTPUT_STEMS.has(name);
}

/**
 * The name an output artifact reads by. The workspace document it descends
 * from wins, because that is the file the user recognizes; failing that the
 * document name the model emitted, unless it is a generic raw-wrapper stem;
 * and only then the artifact's own path, which carries run-storage internals
 * such as the revision folder.
 */
export function outputDisplayName(file: OutputFileInfo): string {
  const document = file.lineage?.document;
  if (document) return fileLocationShortDisplayPath(document);

  const { source } = file;
  if (source && !isGenericOutputStem(source)) {
    // Treat a trailing all-alpha suffix as a real extension (.tex, .txt,
    // .bib…). Suffixes containing digits (.v2, .r3) are version qualifiers,
    // not extensions, so `.tex` is appended in those cases.
    return /\.[a-zA-Z]+$/.test(source) ? source : `${source}.tex`;
  }
  return fileLocationShortDisplayPath(file.location);
}

/**
 * The +/- counts an artifact's diff chip shows, or `null` when there is no
 * chip to show. `DiffStats` is partial because a brand-new file is recorded as
 * `{ added }` with nothing removed, so a present-but-absent side reads as
 * zero — but stats with neither side are a *failed* diff computation, and
 * rendering those as `+0 -0` would state a change count nobody measured.
 */
export function outputDiffCounts(
  diff: DiffStats | null | undefined,
): { added: number; removed: number } | null {
  if (!diff || (diff.added === undefined && diff.removed === undefined)) {
    return null;
  }
  return { added: diff.added ?? 0, removed: diff.removed ?? 0 };
}

/**
 * Flattened projection of {@link OutputFileInfo} for agent results and
 * run metadata. It keeps persisted workflow summaries independent from
 * the richer file-location internals used while a run is active.
 */
const OutputFileSummarySchema = Schema.Struct({
  round: RoundNumberSchema,
  relativePath: Schema.String,
  absolutePath: Schema.String,
  location: Schema.Literals(['workspace', 'runStorage', 'external']),
  originalPath: Schema.NullOr(Schema.String),
  added: Schema.NullOr(LineCountSchema),
  removed: Schema.NullOr(LineCountSchema),
});

const CompileFailureSchema = Schema.Struct({
  round: RoundNumberSchema,
  displayName: Schema.String,
  output: FileLocationSchema,
  log: FileLocationSchema,
  logRelativePath: Schema.String,
});

/**
 * The output a finished run treats as final: the last output of the highest
 * round. The CLI's prior pickers both kept the later element on a round tie,
 * and callers' output order is not guaranteed to lead with the primary
 * document.
 */
export function finalWorkflowOutput(
  outputs: readonly OutputFileSummary[],
): OutputFileSummary | undefined {
  if (outputs.length === 0) return undefined;

  const finalRound = Math.max(...outputs.map((output) => output.round));
  return outputs.findLast((output) => output.round === finalRound);
}

/**
 * Flattened projection of {@link CompileFailure} for agent results and
 * run metadata.
 */
const CompileFailureSummarySchema = Schema.Struct({
  round: RoundNumberSchema,
  displayName: Schema.String,
  outputPath: Schema.String,
  logPath: Schema.String,
  logAbsolutePath: Schema.String,
});
type CompileFailureSummary = typeof CompileFailureSummarySchema.Type;

const LatexdiffPairSchema = Schema.Struct({
  /** The round's output the diff marks up. */
  revised: FileLocationSchema,
  /** The workspace document the output descends from, which names it. */
  document: Schema.NullOr(FileLocationSchema),
  base: FileLocationSchema,
  /** The round the base came from; null for the task's starting document. */
  baseRound: Schema.NullOr(RoundNumberSchema),
  /** The math markup latexdiff ran with, so a host can tell a diff made
   *  under another setting. */
  mathMarkup: Schema.Literals(LATEXDIFF_MATH_MARKUP_VALUES),
});

/** One latexdiff of a round's output against a base: its marked-up file,
 *  or why latexdiff failed. */
const LatexdiffEntrySchema = Schema.Union([
  LatexdiffPairSchema.mapFields(
    Struct.assign({
      status: Schema.Literal('ok'),
      diff: FileLocationSchema,
    }),
  ),

  LatexdiffPairSchema.mapFields(
    Struct.assign({
      status: Schema.Literal('failed'),
      error: Schema.String,
    }),
  ),
]);
export type LatexdiffEntry = typeof LatexdiffEntrySchema.Type;

/** The name a latexdiff entry reads by: its workspace document's file name,
 *  else its base's path. */
export function latexdiffDisplayName(entry: LatexdiffEntry): string {
  return entry.document
    ? getBasename(fileLocationShortDisplayPath(entry.document))
    : fileLocationShortDisplayPath(entry.base);
}

/** What a round's compile check found: why it checked nothing, or the
 *  outputs that failed and whether that rejects the revision (the setting
 *  as the check read it). */
const CompileOutcomeSchema = Schema.TaggedUnion({
  skipped: { reason: Schema.String },
  checked: {
    failures: Schema.Array(CompileFailureSchema),
    rejected: Schema.Boolean,
  },
});
export type CompileOutcome = typeof CompileOutcomeSchema.Type;

/** The outputs of a round that failed to compile; none when it was not
 *  checked. */
export function compileFailuresOf(
  round: Pick<RoundOutput, 'compile'>,
): readonly CompileFailure[] {
  return round.compile?._tag === 'checked' ? round.compile.failures : [];
}

export const RoundOutputSchema = Schema.Struct({
  round: RoundNumberSchema,
  outputs: Schema.Array(OutputFileInfoSchema),
  /** The round's compile check; null until `document_compile` ran. */
  compile: Schema.NullOr(CompileOutcomeSchema),
  /** What this round should have written and did not: the expected output
   *  files it lacks (the disk check owns those) and the documents its reply
   *  held that did not extract. Persisted with all round outputs in the
   *  documents plugin's output fact. */
  missingOutputs: Schema.Array(Schema.String),
  /** The round's latexdiffs, as its last `document_diff` wrote them. */
  latexdiffs: Schema.Array(LatexdiffEntrySchema),
  /** Where the round's reply is kept, which a reader opens to check the
   *  documents it should have held; null until extraction keeps it. */
  reply: Schema.NullOr(FileLocationSchema),
});
export type RoundOutput = typeof RoundOutputSchema.Type;

/** Every round's outputs flattened, each at the round that wrote it. */
export function roundOutputsToOutputSummaries(
  roundOutputs: readonly RoundOutput[],
): OutputFileSummary[] {
  return roundOutputs.flatMap((roundOutput) =>
    roundOutput.outputs.map((output): OutputFileSummary => ({
      round: roundOutput.round,
      relativePath: fileLocationDisplayPath(output.location),
      absolutePath: output.location.absolutePath,
      location: output.location.kind,
      originalPath: output.lineage?.base.absolutePath ?? null,
      added: output.diff?.added ?? null,
      removed: output.diff?.removed ?? null,
    })),
  );
}

export function roundOutputsToCompileFailureSummaries(
  roundOutputs: readonly RoundOutput[],
): CompileFailureSummary[] {
  return roundOutputs.flatMap((roundOutput) =>
    compileFailuresOf(roundOutput).map((failure): CompileFailureSummary => ({
      round: failure.round,
      displayName: failure.displayName,
      outputPath: fileLocationDisplayPath(failure.output),
      logPath: failure.logRelativePath,
      logAbsolutePath: failure.log.absolutePath,
    })),
  );
}

export type OutputFileSummary = typeof OutputFileSummarySchema.Type;
export type CompileFailure = typeof CompileFailureSchema.Type;

/** A diff of one output against the document it started from, written to
 *  the run's storage for a reader to open (`diffRelPath`). */
const ResultDiffSummarySchema = Schema.Struct({
  /** The output's absolute path. */
  path: Schema.String,
  diffRelPath: Schema.String,
  largeChange: Schema.Boolean,
});
export type ResultDiffSummary = typeof ResultDiffSummarySchema.Type;

/** The diffs of a task's proposed revision, as its documents fact records them:
 *  absent until the task proposes; `diffsUnavailable` says why they are not. */
export const DocumentDiffsSchema = Schema.Struct({
  diffs: Schema.optional(Schema.Array(ResultDiffSummarySchema)),
  diffsUnavailable: Schema.optional(Schema.String),
});
export type DocumentDiffs = typeof DocumentDiffsSchema.Type;

/**
 * What a document task's run reports: every revision's outputs and compile
 * failures, and its proposed revision's diffs. Its recipe returns it, so it is
 * the run's `output.structured`.
 */
export const DocumentsResultSchema = Schema.Struct({
  outputs: Schema.Array(OutputFileSummarySchema),
  compileFailures: Schema.Array(CompileFailureSummarySchema),
  diffs: Schema.Array(ResultDiffSummarySchema),
  diffsUnavailable: Schema.optional(Schema.String),
});
export type DocumentsResult = typeof DocumentsResultSchema.Type;

/** The documents a run reports, when its value is a document task's. */
export function documentsResultOf(
  structured: unknown,
): DocumentsResult | undefined {
  const parsed = Schema.decodeUnknownResult(DocumentsResultSchema)(structured);
  return Result.isSuccess(parsed) ? parsed.success : undefined;
}
