import { z } from 'zod';

import { DiffStatsSchema, LineCountSchema } from './lineChanges';
import { ExecutionIdSchema } from './identifiers';
import { RoundNumberSchema } from './roundIndexed';

const WorkspaceFileLocationSchema = z.strictObject({
  kind: z.literal('workspace'),
  absolutePath: z.string(),
  relativePath: z.string(),
});

const RunStorageFileLocationSchema = z.strictObject({
  kind: z.literal('runStorage'),
  absolutePath: z.string(),
  relativePath: z.string(),
  executionId: ExecutionIdSchema,
});

const ExternalFileLocationSchema = z.strictObject({
  kind: z.literal('external'),
  absolutePath: z.string(),
});

/** Discriminated union of all file location types */
export const FileLocationSchema = z.discriminatedUnion('kind', [
  WorkspaceFileLocationSchema,
  RunStorageFileLocationSchema,
  ExternalFileLocationSchema,
]);

/** Agent outputs are workspace or runStorage, never external */
export const AgentFileLocationSchema = z.discriminatedUnion('kind', [
  WorkspaceFileLocationSchema,
  RunStorageFileLocationSchema,
]);

export type WorkspaceFileLocation = z.infer<typeof WorkspaceFileLocationSchema>;
export type RunStorageFileLocation = z.infer<
  typeof RunStorageFileLocationSchema
>;
export type ExternalFileLocation = z.infer<typeof ExternalFileLocationSchema>;
export type FileLocation = z.infer<typeof FileLocationSchema>;
export type AgentFileLocation = z.infer<typeof AgentFileLocationSchema>;

/** Run identity used when accepting an edited file as a postfixed copy. */
export const AcceptCopyMetaSchema = z.strictObject({
  agent: z.string(),
  model: z.string(),
  round: RoundNumberSchema,
});

export type AcceptCopyMeta = z.infer<typeof AcceptCopyMetaSchema>;

const OutputFileSchema = z.strictObject({
  source: z.string(),
  location: FileLocationSchema,
});

const FileLineageSchema = z.strictObject({
  original: FileLocationSchema.nullable(),
  diffBase: FileLocationSchema.nullable(),
  diffFile: FileLocationSchema.nullable(),
});
export type FileLineage = z.infer<typeof FileLineageSchema>;

/**
 * The file location a diff should render against: the explicit `diffBase`
 * when the file was rewritten in place (so a diff against the current path
 * would show no change), falling back to `original`.
 */
export function getEffectiveDiffBase(
  lineage: FileLineage | null | undefined,
): FileLocation | null {
  return lineage?.diffBase ?? lineage?.original ?? null;
}

export const OutputFileInfoSchema = OutputFileSchema.extend({
  round: RoundNumberSchema.prefault(() => 0),
  lineage: FileLineageSchema.nullable(),
  diff: DiffStatsSchema.nullable(),
});

export const OutputFileInfoListSchema = OutputFileInfoSchema.array();

/**
 * Flattened projection of {@link OutputFileInfo} for agent results and
 * execution metadata. It keeps persisted workflow summaries independent from
 * the richer file-location internals used while a run is active.
 */
export const OutputFileSummarySchema = z.object({
  round: RoundNumberSchema,
  relativePath: z.string(),
  absolutePath: z.string(),
  location: z.enum(['workspace', 'runStorage', 'external']),
  originalPath: z.string().nullable(),
  added: LineCountSchema.nullable(),
  removed: LineCountSchema.nullable(),
});

export const CompileFailureSchema = z.strictObject({
  round: RoundNumberSchema,
  displayName: z.string(),
  output: FileLocationSchema,
  log: FileLocationSchema,
  logRelativePath: z.string(),
});

export type OutputFileInfo = z.infer<typeof OutputFileInfoSchema>;
export type OutputFileSummary = z.infer<typeof OutputFileSummarySchema>;
export type CompileFailure = z.infer<typeof CompileFailureSchema>;

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
 * execution metadata.
 */
export const CompileFailureSummarySchema = z.object({
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
  rawOutput: FileLocationSchema.nullable(),
  outputs: OutputFileInfoSchema.array(),
  compileFailures: CompileFailureSchema.array().prefault(() => []),
});
export type RoundOutput = z.infer<typeof RoundOutputSchema>;

function displayPath(location: FileLocation): string {
  return location.kind === 'external'
    ? location.absolutePath
    : location.relativePath;
}

export const OutputFileSummaryFromInfoSchema = OutputFileInfoSchema.transform(
  (output) => ({
    round: output.round,
    relativePath: displayPath(output.location),
    absolutePath: output.location.absolutePath,
    location: output.location.kind,
    originalPath: getEffectiveDiffBase(output.lineage)?.absolutePath ?? null,
    added: output.diff?.added ?? null,
    removed: output.diff?.removed ?? null,
  }),
).pipe(OutputFileSummarySchema);

export const CompileFailureSummaryFromFailureSchema =
  CompileFailureSchema.transform((failure) => ({
    round: failure.round,
    displayName: failure.displayName,
    outputPath: displayPath(failure.output),
    logPath: failure.logRelativePath,
    logAbsolutePath: failure.log.absolutePath,
  })).pipe(CompileFailureSummarySchema);

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

// ============================================================================
// Unified output protocol tag names
// (`docs/proposals/2026-04-30-unified-output-protocol.md`)
// ============================================================================
//
// Every bundled and custom agent converged on one output container —
// `<documents><document name="...">...</document></documents>` — so these
// are fixed protocol constants, not per-agent configuration. They used to be
// threaded through as `settings.documentTag` / `settings.endTag`; that
// configurability is gone (see `AgentDataclass.ts`'s legacy-field strip), and
// every consumer reads these constants directly instead.

/** Outer container tag wrapping every document the model emits. */
export const OUTPUT_DOCUMENTS_TAG = 'documents';

/** Per-document child tag inside the container, carrying a `name` attribute. */
export const OUTPUT_DOCUMENT_TAG = 'document';

/** Closing tag that marks a complete response. */
export const OUTPUT_END_TAG = `</${OUTPUT_DOCUMENTS_TAG}>`;
