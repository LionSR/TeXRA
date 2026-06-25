/**
 * Output discovery for latexdiff: locate the per-round revised `.tex` files
 * for a run, either by reading run-storage on disk or by pulling persisted
 * stream-tab metadata from a matching execution.
 */

// Standard library imports
import * as path from 'node:path';

// Local imports
import { platform } from '@platform/platform';
import { StreamSnapshotStore } from '@transcript';
import { listExecutions } from '@agent/storage';
import {
  WORKFLOW_OUTPUT_BASENAME,
  parseWorkflowOutputRoundDir,
} from '@agent/output/workflowOutputLayout';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { isFileNotFoundError, toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import type {
  ExecutionId,
  FileLocation,
  OutputFileInfo,
} from '@shared/schemas';
import {
  WorkspaceFS,
  createRunStorageLocation,
  pathToLocation,
  resolveRunDir,
} from '@utils/files';
import { hasExtension } from '@utils/core/pathCore';
import { isDirectory, isFile } from '@utils/files/fsEntryType';

import { CHANNEL } from './service';

/**
 * Recursively collect all `.tex` file paths under `dir`, returned as paths
 * relative to `dir` using forward slashes (e.g. `"chapters/main.tex"`).
 */
export async function collectTexFiles(
  dir: string,
  prefix = '',
): Promise<string[]> {
  let entries: [string, number][];
  try {
    entries = await platform().fs.readDirectory(dir);
  } catch (error) {
    // This is a recovery scan: a missing/unreadable subtree means this subtree
    // contributes no outputs, but other rounds/subtrees may still be useful.
    if (isFileNotFoundError(error)) return [];
    logger.warn(CHANNEL, `Skipping unreadable directory '${dir}': ${error}`);
    return [];
  }
  const results: string[] = [];
  for (const [name, type] of entries) {
    const absPath = path.join(dir, name);
    // Skip symlinks — they are mirrored dependency copies placed by
    // ensureMirroredInRoundDir, not revised outputs.
    if (
      await platform()
        .fs.isSymlink(absPath)
        .catch(() => false)
    )
      continue;
    if (isFile(type)) {
      if (hasExtension(name, '.tex')) {
        results.push(prefix ? `${prefix}/${name}` : name);
      }
    } else if (isDirectory(type)) {
      const sub = await collectTexFiles(
        absPath,
        prefix ? `${prefix}/${name}` : name,
      );
      results.push(...sub);
    }
  }
  return results;
}

/**
 * Read `executions/{runId}/r{round}/output.*` directly from disk and build
 * `OutputFileInfo[]` per round. Used as a recovery fallback when the caller
 * supplies a `runId` but stream-tab metadata is missing or stale — in that
 * case the plain workspace scan would return nothing because the new layout
 * lives inside run storage.
 *
 * Lineage `original` is set to the configured `inputFile` so latexdiff has
 * a base to compare against.
 */
export async function scanRunDirForOutputs(
  executionId: ExecutionId,
  inputFile: string,
  extraBaseFiles?: string[],
): Promise<Map<number, OutputFileInfo[]> | null> {
  try {
    const runDirAbsolute = await resolveRunDir(executionId);
    if (!runDirAbsolute) return null;

    const dirEntries = await platform().fs.readDirectory(runDirAbsolute);

    const workspacePath = WorkspaceFS.getPath() ?? '';
    const toAbs = (f: string): string =>
      path.isAbsolute(f) ? f : path.join(workspacePath, f);

    // Build a relative-path (no extension) → workspace location map so
    // multi-output runs with duplicate basenames (e.g. chapters/main.tex and
    // appendix/main.tex) don't collide. fileRelToRound mirrors the workspace
    // relative path for XML-extracted files, so the keys match directly.
    const baseLocationByRelPath = new Map<string, FileLocation>();
    for (const bf of [inputFile, ...(extraBaseFiles ?? [])]) {
      const abs = toAbs(bf);
      const rel = (workspacePath ? path.relative(workspacePath, abs) : bf)
        .replaceAll('\\', '/')
        .replace(/\.tex$/i, '');
      baseLocationByRelPath.set(rel, pathToLocation(abs));
    }
    const defaultBaseLocation = pathToLocation(toAbs(inputFile));

    const rounds = new Map<number, OutputFileInfo[]>();

    for (const [entryName, fileType] of dirEntries) {
      if (!isDirectory(fileType)) continue;
      const round = parseWorkflowOutputRoundDir(entryName);
      if (round == null) continue;

      const roundDirAbsolute = path.join(runDirAbsolute, entryName);
      // Skip symlinked round dirs. Use lstat through the platform because
      // readDirectory FileType values do not reliably include SymbolicLink.
      if (
        await platform()
          .fs.isSymlink(roundDirAbsolute)
          .catch(() => false)
      )
        continue;

      const outputs: OutputFileInfo[] = [];
      // Collect .tex files recursively — extracted docs may live in subdirs
      // (e.g. r0/chapters/main.tex) when source names include path segments.
      const allTexFiles = await collectTexFiles(roundDirAbsolute);
      // Between-round artifacts written to run storage always carry both round
      // numbers (e.g. output_diffr1r0.tex). The bare _diff suffix only appears
      // in workspace-side diffs, never here, so a legitimately-named source
      // like "chapter_diff.tex" is not mistakenly dropped.
      const nonArtifact = allTexFiles.filter(
        (f) => !/_diffr\d+r\d+$/.test(path.parse(f).name),
      );
      // Raw round output is output.xml (never collected by collectTexFiles).
      // Guard for pre-refactor runs where non-scratchpad agents wrote output.tex
      // as the raw wrapper: drop it when real extracted outputs exist alongside.
      const rawStem = `${WORKFLOW_OUTPUT_BASENAME}.tex`;
      const texFiles =
        nonArtifact.length > 1 && nonArtifact.includes(rawStem)
          ? nonArtifact.filter((f) => f !== rawStem)
          : nonArtifact;
      for (const fileRelToRound of texFiles) {
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
        const fileKey = fileRelToRound
          .replaceAll('\\', '/')
          .replace(/\.tex$/i, '');
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
            diffFile: null,
          },
          diff: null,
        });
      }

      if (outputs.length > 0) rounds.set(round, outputs);
    }

    return rounds.size > 0
      ? new Map([...rounds.entries()].sort((a, b) => a[0] - b[0]))
      : null;
  } catch (error) {
    logger.debug(
      CHANNEL,
      `RunDir scan for ${executionId} failed: ${toErrorMessage(error)}`,
    );
    return null;
  }
}

/**
 * When the caller didn't supply `outputsByRound`, look up the most recent
 * execution whose `agent + model + inputFile` match the request and pull
 * its persisted `OutputFileInfo[]` from the stream-tab store. Returns null
 * when no matching execution exists.
 */
export async function discoverLatestExecutionOutputs(query: {
  agent: string;
  model: string;
  inputFile: string;
}): Promise<{
  executionId: ExecutionId;
  rounds: Map<number, OutputFileInfo[]>;
} | null> {
  try {
    const executions = await listExecutions();
    // Normalize both sides so trivial path-format differences (duplicate
    // separators, `./`, mixed forward/backslash) don't silently miss a
    // matching execution.
    const normalizedInput = path.normalize(query.inputFile);

    const candidates = executions
      .filter((entry) => {
        if (entry.agent !== query.agent || entry.model !== query.model) {
          return false;
        }
        const entryInput = entry.agentConfig?.inputFiles?.[0];
        return (
          typeof entryInput === 'string' &&
          path.normalize(entryInput) === normalizedInput
        );
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const snapshots = new StreamSnapshotStore();
    for (const candidate of candidates) {
      const streamId = getStreamTabId(candidate.agent, candidate.model, {
        executionId: candidate.id,
      });
      const rounds = await snapshots.readOutputFiles(streamId);
      if (rounds && rounds.size > 0) {
        return { executionId: candidate.id, rounds };
      }
    }
  } catch (error) {
    logger.debug(
      CHANNEL,
      `Metadata-driven latexdiff discovery failed: ${toErrorMessage(error)}`,
    );
  }
  return null;
}
