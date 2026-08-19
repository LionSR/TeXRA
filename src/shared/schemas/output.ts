import { z } from 'zod';

import { getBasename } from '@utils/core';
import {
  DiffStatsSchema,
  LineCountSchema,
  type DiffStats,
} from './lineChanges';
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

// ============================================================================
// How a file location reads to a human
// ============================================================================
//
// One vocabulary for turning a `FileLocation` into text, shared by the agent
// core, both webview hosts and the CLI TUI. It lives beside the schema rather
// than in `@utils/files` because the webviews cannot reach a module that
// imports `node:path`, and a browser-unreachable definition is exactly how
// this rule came to be re-derived in every renderer.

/**
 * How a location reads as a path: workspace and run-storage files by their
 * relative path — that is how the user and the agent's file tools refer to
 * them — and external files by their absolute path, the only path they have.
 *
 * This doubles as a location's comparable identity: two locations naming the
 * same file agree here, so output-to-base maps key on it.
 */
export function fileLocationDisplayPath(location: FileLocation): string {
  return location.kind === 'external'
    ? location.absolutePath
    : location.relativePath;
}

/**
 * Like {@link fileLocationDisplayPath} but collapses an external location to
 * its basename, so a long absolute path (e.g. a run-storage file resolved as
 * external because it sits outside the workspace root) cannot dominate a UI
 * row or a prompt line. The full path stays on `absolutePath`.
 */
export function fileLocationShortDisplayPath(location: FileLocation): string {
  return location.kind === 'external'
    ? getBasename(location.absolutePath)
    : location.relativePath;
}

/**
 * Reference to a run-storage file the way an agent prompt addresses it:
 * `/executions/<executionId>/files/<relativePath>`. The one definition of that
 * convention.
 */
export function runStorageFilePath(
  executionId: string,
  relativePath: string,
): string {
  return `/executions/${executionId}/files/${relativePath}`;
}

/**
 * How a location is addressed in text that leaves the UI — copied run context,
 * follow-up prompts, subagent results. A run-storage location carries the
 * execution that owns it, so its `/executions/...` route resolves without the
 * caller supplying one; every other kind reads as its display path.
 */
export function fileLocationAddressPath(location: FileLocation): string {
  return location.kind === 'runStorage'
    ? runStorageFilePath(location.executionId, location.relativePath)
    : fileLocationDisplayPath(location);
}

// Generic raw-wrapper stems are run-storage internals, not the meaningful
// document name, so they must never surface as an artifact's name.
const GENERIC_OUTPUT_STEMS = new Set(['output', 'output.xml', 'output.tex']);

/** Whether a document name is a generic raw-wrapper stem rather than a name. */
export function isGenericOutputStem(name: string): boolean {
  return GENERIC_OUTPUT_STEMS.has(name);
}

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

export const OutputFileSummaryFromInfoSchema = OutputFileInfoSchema.transform(
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

export const CompileFailureSummaryFromFailureSchema =
  CompileFailureSchema.transform((failure) => ({
    round: failure.round,
    displayName: failure.displayName,
    outputPath: fileLocationDisplayPath(failure.output),
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
