/**
 * Output discovery for latexdiff: locate the per-round revised `.tex` files
 * for a run, either by reading run-storage on disk or by pulling persisted
 * stream-tab metadata from a matching execution.
 */

// Node imports
import * as path from 'node:path';

// Local imports
import { isFileNotFoundError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
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
import { StreamSnapshotStore } from '@transcript';
import { toNewestFirstByTimestamp } from '@utils/core';
import {
  createRunStorageLocation,
  pathToLocation,
} from '@utils/files/fileLocation';
import { findRunDir } from '@utils/files/runStorageFs';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { hasExtension } from '@utils/core/pathCore';
import { isDirectory, isFile } from '@utils/files/fsEntryType';

// Local file imports
import { hasBetweenRoundDiffSuffix } from './diffFileNameManager';
import type { LatexExecutionDiscoveryPort } from './executionDiscovery';

/**
 * Recursively collect all `.tex` file paths under `dir`, returned as paths
 * relative to `dir` using forward slashes (e.g. `"chapters/main.tex"`).
 */
async function collectTexFiles(
  dir: string,
  channel: string,
  prefix = '',
): Promise<string[]> {
  const fs = platform().fs;
  const log = createLog(channel);
  let entries: [string, number][];
  try {
    entries = await fs.readDirectory(dir);
  } catch (error) {
    // This is a recovery scan: a missing/unreadable subtree means this subtree
    // contributes no outputs, but other rounds/subtrees may still be useful.
    if (isFileNotFoundError(error)) return [];
    log.warn(`Skipping unreadable directory '${dir}': ${error}`);
    return [];
  }
  const results: string[] = [];
  for (const [name, type] of entries) {
    const absPath = path.join(dir, name);
    // Skip symlinks — they are mirrored dependency copies placed by
    // ensureMirroredInRoundDir, not revised outputs.
    if (await fs.isSymlink(absPath).catch(() => false)) continue;
    const relative = prefix ? `${prefix}/${name}` : name;
    if (isFile(type) && hasExtension(name, '.tex')) {
      results.push(relative);
    } else if (isDirectory(type)) {
      results.push(...(await collectTexFiles(absPath, channel, relative)));
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
  extraBaseFiles: string[] | undefined,
  channel: string,
): Promise<RoundIndexed<OutputFileInfo> | null> {
  const log = createLog(channel);
  try {
    const runDirAbsolute = await findRunDir(executionId);
    if (!runDirAbsolute) return null;

    const fs = platform().fs;
    const dirEntries = await fs.readDirectory(runDirAbsolute);

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
      const relSource = workspacePath ? path.relative(workspacePath, abs) : bf;
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
      if (await fs.isSymlink(roundDirAbsolute).catch(() => false)) continue;

      const outputs: OutputFileInfo[] = [];
      // Collect .tex files recursively — extracted docs may live in subdirs
      // (e.g. r0/chapters/main.tex) when source names include path segments.
      const allTexFiles = await collectTexFiles(roundDirAbsolute, channel);
      // Between-round artifacts written to run storage always carry both round
      // numbers (e.g. output_diffr1r0.tex). The bare _diff suffix only appears
      // in workspace-side diffs, never here, so a legitimately-named source
      // like "chapter_diff.tex" is not mistakenly dropped.
      const nonArtifact = allTexFiles.filter(
        (f) => !hasBetweenRoundDiffSuffix(path.parse(f).name),
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
            diffFile: null,
          },
          diff: null,
        });
      }

      if (outputs.length > 0) rounds[round] = outputs;
    }

    return Object.keys(rounds).length > 0 ? rounds : null;
  } catch (error) {
    // A failed run-storage read degrades a pinned-runId invocation to the
    // plain workspace scan — a behavior-changing fallback, so fallback
    // discipline (review checklist §15) forbids logging it below warn.
    log.warn(`RunDir scan for ${executionId} failed: ${toErrorMessage(error)}`);
    return null;
  }
}

/**
 * When the caller didn't supply `outputsByRound`, look up the most recent
 * execution whose `agent + model + inputFile` match the request and pull
 * its persisted `OutputFileInfo[]` from the stream-tab store. Returns null
 * when no matching execution exists.
 */
export async function discoverLatestExecutionOutputs(
  discovery: LatexExecutionDiscoveryPort,
  query: {
    agent: string;
    model: string;
    inputFile: string;
  },
  channel: string,
): Promise<{
  executionId: ExecutionId;
  rounds: RoundIndexed<OutputFileInfo>;
} | null> {
  const log = createLog(channel);
  try {
    const executions = await discovery.listAgentRuns();
    // Normalize both sides so trivial path-format differences (duplicate
    // separators, `./`, mixed forward/backslash) don't silently miss a
    // matching execution.
    const normalizedInput = path.normalize(query.inputFile);

    const candidates = toNewestFirstByTimestamp(
      executions.filter((entry) => {
        if (entry.agent !== query.agent || entry.model !== query.model) {
          return false;
        }
        const entryInput = entry.inputFiles[0];
        return (
          typeof entryInput === 'string' &&
          path.normalize(entryInput) === normalizedInput
        );
      }),
      (entry) => entry.timestamp,
    );

    const snapshots = new StreamSnapshotStore();
    for (const candidate of candidates) {
      // The stream stamped on execution metadata addresses its snapshot
      // directly; identity is never rebuilt from agent/model configuration.
      // Records without one go straight to the run-directory scan below.
      const streamId = await discovery.readStreamId(candidate.id);
      if (streamId !== undefined) {
        const rounds = await snapshots.readOutputFiles(streamId);
        if (rounds && Object.keys(rounds).length > 0) {
          return { executionId: candidate.id, rounds };
        }
      }
      // Stream-tab snapshots are a progress-view artifact that headless
      // `texra run` executions never persist. Fall back to scanning the matched
      // execution's run directory on disk — the same source the `--run-id` path
      // uses — so a headless run's outputs are still discovered instead of
      // dropping through to the cwd-based workspace scan (which only sees files
      // copied back into the workspace, not the per-round execution outputs).
      // Mirror the `--run-id` path's base set: the matched execution's other
      // configured input files become extra diff bases, so a multi-file run's
      // secondary outputs diff against their own originals rather than all
      // collapsing onto the single `-i` file.
      const scanned = await scanRunDirForOutputs(
        candidate.id,
        query.inputFile,
        candidate.inputFiles.slice(1),
        channel,
      );
      if (scanned) {
        return { executionId: candidate.id, rounds: scanned };
      }
    }
  } catch (error) {
    // Same discipline as scanRunDirForOutputs above: a failed persisted
    // metadata read drops the invocation to the workspace scan, so warn.
    log.warn(
      `Metadata-driven latexdiff discovery failed: ${toErrorMessage(error)}`,
    );
  }
  return null;
}
