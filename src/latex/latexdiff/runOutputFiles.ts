/**
 * Output discovery for latexdiff: locate the per-round revised `.tex` files
 * for a run by reading its generated files from run storage.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { isFileNotFoundError } from '@common/errors';
import { withLogChannel } from '@logger/effectLog';
import type { FileSystemProvider } from '@platform/interfaces';
import {
  type ExecutionId,
  type FileLocation,
  type OutputFileInfo,
  type RoundIndexed,
} from '@shared/schemas';
import {
  WORKFLOW_OUTPUT_BASENAME,
  parseWorkflowOutputRoundDir,
} from '@shared/constants/workflowOutput';
import {
  createRunStorageLocation,
  pathToLocation,
} from '@utils/files/fileLocation';
import { findRunDir } from '@utils/files/runStorageFs';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { hasExtension } from '@utils/core/pathCore';
import { isDirectory, isFile } from '@utils/files/fsEntryType';

// Local file imports
import { hasBetweenRoundDiffSuffix } from './diffFileNameManager';

export type RunOutputFilesystem = Pick<
  FileSystemProvider,
  'readDirectory' | 'isSymlink'
>;

/** Whether `absPath` is a symlink; an unreadable entry counts as "not one". */
const isSymlink = (
  fs: RunOutputFilesystem,
  absPath: string,
): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: () => fs.isSymlink(absPath),
    catch: ensureError,
  }).pipe(Effect.orElseSucceed(() => false));

/**
 * Recursively collect all `.tex` file paths under `dir`, returned as paths
 * relative to `dir` using forward slashes (e.g. `"chapters/main.tex"`).
 */
const collectTexFiles = Effect.fn('latexdiff.collectTexFiles')(function* (
  dir: string,
  fs: RunOutputFilesystem,
  prefix = '',
): Effect.fn.Return<string[], never> {
  // This is a recovery scan: a missing/unreadable subtree means this subtree
  // contributes no outputs, but other rounds/subtrees may still be useful.
  const entries = yield* Effect.tryPromise({
    try: () => fs.readDirectory(dir),
    catch: ensureError,
  }).pipe(
    Effect.catch((error) =>
      isFileNotFoundError(error)
        ? Effect.succeed<[string, number][]>([])
        : Effect.logWarning(
            `Skipping unreadable directory '${dir}': ${error}`,
          ).pipe(Effect.as<[string, number][]>([])),
    ),
  );
  const results: string[] = [];
  for (const [name, type] of entries) {
    const absPath = path.join(dir, name);
    // Skip symlinks: they are mirrored dependency copies placed by
    // ensureMirroredInRoundDir, not revised outputs.
    if (yield* isSymlink(fs, absPath)) continue;
    const relative = prefix ? `${prefix}/${name}` : name;
    if (isFile(type) && hasExtension(name, '.tex')) {
      results.push(relative);
    } else if (isDirectory(type)) {
      results.push(...(yield* collectTexFiles(absPath, fs, relative)));
    }
  }
  return results;
});

/**
 * Read `executions/{runId}/r{round}/output.*` directly from disk and build
 * `OutputFileInfo[]` per round. Used as a recovery fallback when the caller
 * supplies a `runId` but stream-tab metadata is missing or stale: in that
 * case the plain workspace scan would return nothing because the new layout
 * lives inside run storage.
 *
 * Lineage `original` is set to the configured `inputFile` so latexdiff has
 * a base to compare against.
 */
export const scanRunDirForOutputs = Effect.fn('latexdiff.scanRunDir')(
  function* (
    executionId: ExecutionId,
    inputFile: string,
    extraBaseFiles: string[] | undefined,
    channel: string,
    fs: RunOutputFilesystem,
  ): Effect.fn.Return<RoundIndexed<OutputFileInfo> | null, never> {
    const scan = Effect.gen(function* () {
      const runDirAbsolute = yield* Effect.tryPromise({
        try: () => findRunDir(executionId),
        catch: ensureError,
      });
      if (!runDirAbsolute) return null;

      const dirEntries = yield* Effect.tryPromise({
        try: () => fs.readDirectory(runDirAbsolute),
        catch: ensureError,
      });

      const workspacePath = WorkspaceFS.getPath() ?? '';
      const toAbs = (f: string): string =>
        path.isAbsolute(f) ? f : path.join(workspacePath, f);
      // Normalize to a forward-slash, extension-less relative key so base files
      // and recovered round outputs can be matched regardless of path format.
      const toRelKey = (p: string): string =>
        p.replaceAll('\\', '/').replace(/\.tex$/i, '');

      // Build a relative-path (no extension) → workspace location map so
      // multi-output runs with duplicate basenames (e.g. chapters/main.tex and
      // appendix/main.tex) don't collide. fileRelToRound mirrors the workspace
      // relative path for XML-extracted files, so the keys match directly.
      const baseLocationByRelPath = new Map<string, FileLocation>();
      for (const bf of [inputFile, ...(extraBaseFiles ?? [])]) {
        const abs = toAbs(bf);
        const relSource = workspacePath
          ? path.relative(workspacePath, abs)
          : bf;
        baseLocationByRelPath.set(toRelKey(relSource), pathToLocation(abs));
      }
      const defaultBaseLocation = pathToLocation(toAbs(inputFile));

      const rounds: RoundIndexed<OutputFileInfo> = {};

      for (const [entryName, fileType] of dirEntries) {
        if (!isDirectory(fileType)) continue;
        const round = parseWorkflowOutputRoundDir(entryName);
        if (round == null) continue;

        const roundDirAbsolute = path.join(runDirAbsolute, entryName);
        // Skip symlinked round dirs. Use lstat through the platform because
        // readDirectory FileType values do not reliably include SymbolicLink.
        if (yield* isSymlink(fs, roundDirAbsolute)) continue;

        const outputs: OutputFileInfo[] = [];
        // Collect .tex files recursively: extracted docs may live in subdirs
        // (e.g. r0/chapters/main.tex) when source names include path segments.
        const allTexFiles = yield* collectTexFiles(roundDirAbsolute, fs);
        // Between-round artifacts written to run storage always carry both round
        // numbers (e.g. output_diffr1r0.tex). The bare _diff suffix only appears
        // in workspace-side diffs, never here, so a legitimately-named source
        // like "chapter_diff.tex" is not mistakenly dropped.
        const nonArtifact = allTexFiles.filter(
          (f) => !hasBetweenRoundDiffSuffix(path.parse(f).name),
        );
        for (const fileRelToRound of nonArtifact) {
          const relativePath = path.join(entryName, fileRelToRound);
          const location = createRunStorageLocation(
            path.join(runDirAbsolute, relativePath),
            relativePath,
            executionId,
          );
          // Preserve subdirectory in source (e.g. "chapters/main") so
          // traceFileLineage can match it back to the workspace original.
          // For the generic "output" stem, fall back to the input file basename
          // so progress labels show the meaningful name instead of "output".
          const sourceNoExt = fileRelToRound.replace(/\.tex$/i, '');
          const source =
            sourceNoExt === WORKFLOW_OUTPUT_BASENAME
              ? path.basename(inputFile)
              : sourceNoExt;
          // Match recovered file to its base by relative path. Fall back to the
          // single configured base only when there's no ambiguity (one candidate);
          // in multi-file runs an unmatched file gets null so it surfaces as a
          // "missing base" error rather than silently diffing against the wrong doc.
          const fileKey = toRelKey(fileRelToRound);
          const originalLocation =
            baseLocationByRelPath.get(fileKey) ??
            (baseLocationByRelPath.size === 1 ? defaultBaseLocation : null);
          outputs.push({
            source,
            round,
            location,
            lineage: {
              original: originalLocation,
              diffBase: null,
            },
            diff: null,
          });
        }

        if (outputs.length > 0) rounds[round] = outputs;
      }

      return Object.keys(rounds).length > 0 ? rounds : null;
    });

    // A failed run-storage read degrades a pinned-runId invocation to the
    // plain workspace scan: a behavior-changing fallback, so fallback
    // discipline (review checklist §15) forbids logging it below warn.
    return yield* scan.pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `RunDir scan for ${executionId} failed: ${toErrorMessage(error)}`,
        ).pipe(Effect.as<RoundIndexed<OutputFileInfo> | null>(null)),
      ),
      withLogChannel(channel),
    );
  },
);
