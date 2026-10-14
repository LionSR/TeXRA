/**
 * The documents plugin's output vocabulary: what a document task's revisions
 * wrote (`RoundOutput`, with their compile failures), the flattened
 * summaries its run's result reports (`DocumentsResult`, the recipe's return
 * value and its run's `output.structured`, with the proposed revision's diffs),
 * and the per-round sidecars hosts show. The harness holds none of it.
 * Browser-safe: it imports only schemas.
 */
import { z } from 'zod';

import {
  FileLocationSchema,
  fileLocationDisplayPath,
  getEffectiveDiffBase,
  LineCountSchema,
  OutputFileInfoSchema,
  roundIndexedRecord,
  RoundNumberSchema,
  type RunId,
} from '@shared/schemas';

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

const CompileResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    round: RoundNumberSchema,
  }),
  z.strictObject({
    status: z.literal('failed'),
    round: RoundNumberSchema,
    failures: z.array(CompileFailureSchema),
    logExcerpt: z.string(),
  }),
]);
export type CompileResult = z.infer<typeof CompileResultSchema>;

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

export const RoundKeyedOutputSidecarValueSchemas = {
  outputFiles: roundIndexedRecord(OutputFileInfoSchema),
  missingOutputs: roundIndexedRecord(z.string()),
  compileFailures: roundIndexedRecord(CompileFailureSchema),
} as const;

/** A run's output files by round, for a host's file decorations. */
export interface AddOutputFilesPayload {
  runId: RunId;
  filesByRound: z.infer<typeof RoundKeyedOutputSidecarValueSchemas.outputFiles>;
}
