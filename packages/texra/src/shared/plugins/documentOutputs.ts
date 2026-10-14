/**
 * The documents plugin's output vocabulary: what a document task's revisions
 * wrote (`RoundOutput`, with their compile failures), the flattened
 * summaries its run's result reports (`DocumentsResult`, the recipe's return
 * value and its run's `output.structured`, with the proposed revision's diffs),
 * the output protocol's tags, and how hosts name and label an output. The
 * harness holds none of it but the `OutputFileInfo` record, which its
 * latexdiff log payload still names.
 * Browser-safe: it imports only schemas.
 */
import { z } from 'zod';

import {
  FileLocationSchema,
  fileLocationDisplayPath,
  fileLocationShortDisplayPath,
  LineCountSchema,
  OutputFileInfoSchema,
  RoundNumberSchema,
  type DiffStats,
  type FileLocation,
  type OutputFileInfo,
} from '@shared/schemas';

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

/**
 * Round number → items for that round, read-only. Runtime keys are strings
 * (JSON); index it with a number.
 */
export type ReadonlyRoundIndexed<T> = {
  readonly [round: number]: readonly T[];
};

/** A round-indexed record's `[round, items]` pairs, ascending by round. */
export function roundIndexedEntries<T>(
  rounds: ReadonlyRoundIndexed<T>,
): [number, readonly T[]][] {
  return Object.entries(rounds)
    .map(([round, items]): [number, readonly T[]] => [Number(round), items])
    .sort((a, b) => a[0] - b[0]);
}

/** Compact round label: `r2`. A zero-based round renders one-based. */
export function formatRoundLabel(round: number): string {
  return `r${round + 1}`;
}

// Generic raw-wrapper stems are run-storage internals, not the meaningful
// document name, so they must never surface as an artifact's name.
const GENERIC_OUTPUT_STEMS = new Set(['output', 'output.xml', 'output.tex']);

/** Whether a document name is a generic raw-wrapper stem rather than a name. */
export function isGenericOutputStem(name: string): boolean {
  return GENERIC_OUTPUT_STEMS.has(name);
}

/** Run identity used when accepting an edited file as a postfixed copy. */
export interface AcceptCopyMeta {
  readonly agent: string;
  readonly model: string;
  readonly round: number;
}

/**
 * The file location a diff should render against: the explicit `diffBase`
 * when the file was rewritten in place (so a diff against the current path
 * would show no change), falling back to `original`.
 */
export function getEffectiveDiffBase(
  lineage: OutputFileInfo['lineage'] | undefined,
): FileLocation | null {
  return lineage?.diffBase ?? lineage?.original ?? null;
}

/**
 * The name an output artifact reads by. The workspace document it descends
 * from wins, because that is the file the user recognizes; failing that the
 * document name the model emitted, unless it is a generic raw-wrapper stem;
 * and only then the artifact's own path, which carries run-storage internals
 * such as the `r<round>/` prefix.
 */
export function outputDisplayName(file: OutputFileInfo): string {
  const original = file.lineage?.original;
  if (original) return fileLocationShortDisplayPath(original);

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
const OutputFileSummarySchema = z.object({
  round: RoundNumberSchema,
  relativePath: z.string(),
  absolutePath: z.string(),
  location: z.enum(['workspace', 'runStorage', 'external']),
  originalPath: z.string().nullable(),
  added: LineCountSchema.nullable(),
  removed: LineCountSchema.nullable(),
});

const CompileFailureSchema = z.strictObject({
  round: RoundNumberSchema,
  displayName: z.string(),
  output: FileLocationSchema,
  log: FileLocationSchema,
  logRelativePath: z.string(),
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
const CompileFailureSummarySchema = z.object({
  round: RoundNumberSchema,
  displayName: z.string(),
  outputPath: z.string(),
  logPath: z.string(),
  logAbsolutePath: z.string(),
});
type CompileFailureSummary = z.infer<typeof CompileFailureSummarySchema>;

export const RoundOutputSchema = z.strictObject({
  round: RoundNumberSchema,
  outputs: OutputFileInfoSchema.array(),
  compileFailures: CompileFailureSchema.array().prefault(() => []),
  /** The expected output files this round did not produce, as last reported.
   *  Persisted with all round outputs in the documents plugin's output fact. */
  missingOutputs: z
    .string()
    .array()
    .prefault(() => []),
});
export type RoundOutput = z.infer<typeof RoundOutputSchema>;

const OutputFileSummaryFromInfoSchema = OutputFileInfoSchema.transform(
  (output) => ({
    round: output.round,
    relativePath: fileLocationDisplayPath(output.location),
    absolutePath: output.location.absolutePath,
    location: output.location.kind,
    originalPath: getEffectiveDiffBase(output.lineage)?.absolutePath ?? null,
    added: output.diff?.added ?? null,
    removed: output.diff?.removed ?? null,
  }),
).pipe(OutputFileSummarySchema);

const CompileFailureSummaryFromFailureSchema = CompileFailureSchema.transform(
  (failure) => ({
    round: failure.round,
    displayName: failure.displayName,
    outputPath: fileLocationDisplayPath(failure.output),
    logPath: failure.logRelativePath,
    logAbsolutePath: failure.log.absolutePath,
  }),
).pipe(CompileFailureSummarySchema);

export function roundOutputsToOutputSummaries(
  roundOutputs: RoundOutput[],
): OutputFileSummary[] {
  return roundOutputs.flatMap((roundOutput) =>
    roundOutput.outputs.map((output) =>
      OutputFileSummaryFromInfoSchema.parse({
        ...output,
        round: roundOutput.round,
      }),
    ),
  );
}

export function roundOutputsToCompileFailureSummaries(
  roundOutputs: RoundOutput[],
): CompileFailureSummary[] {
  return roundOutputs.flatMap((roundOutput) =>
    roundOutput.compileFailures.map((failure) =>
      CompileFailureSummaryFromFailureSchema.parse(failure),
    ),
  );
}

export type OutputFileSummary = z.infer<typeof OutputFileSummarySchema>;
export type CompileFailure = z.infer<typeof CompileFailureSchema>;

/** A diff of one output against the document it started from, written to
 *  the run's storage for a reader to open (`diffRelPath`). */
const ResultDiffSummarySchema = z.strictObject({
  /** The output's absolute path. */
  path: z.string(),
  diffRelPath: z.string(),
  largeChange: z.boolean(),
});
export type ResultDiffSummary = z.infer<typeof ResultDiffSummarySchema>;

/** The diffs of a task's proposed revision, as its documents fact records them:
 *  absent until the task proposes; `diffsUnavailable` says why they are not. */
export const DocumentDiffsSchema = z.strictObject({
  diffs: z.array(ResultDiffSummarySchema).optional(),
  diffsUnavailable: z.string().optional(),
});
export type DocumentDiffs = z.infer<typeof DocumentDiffsSchema>;

/**
 * What a document task's run reports: every revision's outputs and compile
 * failures, and its proposed revision's diffs. Its recipe returns it, so it is
 * the run's `output.structured`.
 */
export const DocumentsResultSchema = z.strictObject({
  outputs: z.array(OutputFileSummarySchema),
  compileFailures: z.array(CompileFailureSummarySchema).prefault(() => []),
  diffs: z.array(ResultDiffSummarySchema).prefault(() => []),
  diffsUnavailable: z.string().optional(),
});
export type DocumentsResult = z.infer<typeof DocumentsResultSchema>;

/** The documents a run reports, when its value is a document task's. */
export function documentsResultOf(
  structured: unknown,
): DocumentsResult | undefined {
  const parsed = DocumentsResultSchema.safeParse(structured);
  return parsed.success ? parsed.data : undefined;
}
