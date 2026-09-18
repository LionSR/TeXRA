/**
 * Output discovery for latexdiff: locate the per-round revised `.tex` files
 * for a run by reading its generated files from run storage.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, type FileSystem, type Path } from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import {
  type RunId,
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
  pathToLocationIn,
} from '@utils/files/fileLocation';
import { findRunDirUnder } from '@utils/files/runStorageFs';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { hasExtension } from '@utils/core/pathCore';
import { readDirectoryTypedTolerant } from '@utils/files/fsDurability';

// Local file imports
import { hasBetweenRoundDiffSuffix } from './diffFileNameManager';

/**
 * Recursively collect all `.tex` file paths under `dir`, returned as paths
 * relative to `dir` using forward slashes (e.g. `"chapters/main.tex"`).
 *
 * The listing carries each entry's own (unfollowed) type, so a symlink reports
 * as one here and needs no second probe: mirrored dependency copies placed by
 * `ensureMirroredInRoundDir` are links, not revised outputs, and are skipped.
 */
const collectTexFiles = Effect.fn('latexdiff.collectTexFiles')(function* (
  dir: string,
  prefix = '',
): Effect.fn.Return<string[], never, FileSystem.FileSystem | Path.Path> {
  // This is a recovery scan: a missing/unreadable subtree means this subtree
  // contributes no outputs, but other rounds/subtrees may still be useful.
  const entries = yield* readDirectoryTypedTolerant(dir).pipe(
    Effect.catch((error) =>
      error.reason._tag === 'NotFound'
        ? Effect.succeed<readonly (readonly [string, FileSystem.File.Type])[]>(
            [],
          )
        : Effect.logWarning(
            `Skipping unreadable directory '${dir}': ${error}`,
          ).pipe(
            Effect.as<readonly (readonly [string, FileSystem.File.Type])[]>([]),
          ),
    ),
  );
  const results: string[] = [];
  for (const [name, type] of entries) {
    if (type === 'SymbolicLink') continue;
    const relative = prefix ? `${prefix}/${name}` : name;
    if (type === 'File' && hasExtension(name, '.tex')) {
      results.push(relative);
    } else if (type === 'Directory') {
      results.push(...(yield* collectTexFiles(path.join(dir, name), relative)));
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
    runId: RunId,
    storageRoot: string,
    workspaceRoot: string | undefined,
    inputFile: string,
    extraBaseFiles: string[] | undefined,
    channel: string,
  ): Effect.fn.Return<
    RoundIndexed<OutputFileInfo> | null,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const scan = Effect.gen(function* () {
      const runDirAbsolute = yield* findRunDirUnder(storageRoot, runId);
      if (!runDirAbsolute) return null;

      const dirEntries = yield* readDirectoryTypedTolerant(runDirAbsolute);

      const workspacePath = workspaceRoot ?? '';
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
        baseLocationByRelPath.set(
          toRelKey(relSource),
          pathToLocationIn(workspaceRoot, abs),
        );
      }
      const defaultBaseLocation = pathToLocationIn(
        workspaceRoot,
        toAbs(inputFile),
      );

      const rounds: RoundIndexed<OutputFileInfo> = {};

      // A symlinked round dir reports as `SymbolicLink`, never as the
      // directory it points at, so this one check also skips it.
      for (const [entryName, fileType] of dirEntries) {
        if (fileType !== 'Directory') continue;
        const round = parseWorkflowOutputRoundDir(entryName);
        if (round == null) continue;

        const roundDirAbsolute = path.join(runDirAbsolute, entryName);
        const outputs: OutputFileInfo[] = [];
        // Collect .tex files recursively: extracted docs may live in subdirs
        // (e.g. r0/chapters/main.tex) when source names include path segments.
        const allTexFiles = yield* collectTexFiles(roundDirAbsolute);
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
            runId,
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
          `RunDir scan for ${runId} failed: ${toErrorMessage(error)}`,
        ).pipe(Effect.as<RoundIndexed<OutputFileInfo> | null>(null)),
      ),
      withLogChannel(channel),
    );
  },
);
