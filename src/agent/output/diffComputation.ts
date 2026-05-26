/**
 * Diff statistics computation for output files.
 *
 * Computes line-based diff statistics between base files and outputs
 * using the diff-match-patch library.
 */

import { diff_match_patch } from 'diff-match-patch';

import type { DiffStats } from '@agent/types/DiffTypes';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import type { OutputFileInfo, FileLocation } from '@shared/schemas';
import {
  AbsoluteFS,
  createWorkspaceLocation,
  flexibleFS,
  getComparablePath,
  WorkspaceFS,
} from '@utils/files';
import { countLines } from '@utils/text/stringUtils';

import { traceFileLineage } from './lineageMapping';
import { ensureRound, type OutputState } from './outputState';
import type { RoundFileMapping } from './types';

const CHANNEL = 'OutputDiffStats';
logger.initialize(CHANNEL);

// ============================================================================
// Helpers
// ============================================================================

/** Computes diff statistics between base and output files. */
async function computeDiffStats(
  baseLocation: FileLocation | null,
  outputLocation: FileLocation,
): Promise<DiffStats> {
  try {
    if (!baseLocation) {
      const outContent = await flexibleFS.read(outputLocation);
      const added = countLines(outContent);
      return { added };
    }

    const [baseContent, outContent] = await Promise.all([
      flexibleFS.read(baseLocation),
      flexibleFS.read(outputLocation),
    ]);

    const dmp = new diff_match_patch();
    const diffs = dmp.diff_main(baseContent, outContent);
    let added = 0;
    let removed = 0;
    for (const [op, text] of diffs) {
      if (op === 1) {
        added += countLines(text);
      } else if (op === -1) {
        removed += countLines(text);
      }
    }
    return { added, removed };
  } catch (err) {
    logger.debug(
      CHANNEL,
      `Failed to compute diff stats: ${toErrorMessage(err)}`,
    );
    return {};
  }
}

/** The +/- diff stats must be computed against the immutable pre-run
 *  snapshot (in-place workflows overwrite the live file, so the snapshot is
 *  the only surviving "before"). But the lineage `original` exposed to the
 *  UI should point at the live workspace document so the "compare" action
 *  diffs — and lets the user edit — their real file rather than the
 *  read-only run-storage copy. Snapshot locations carry the workspace-relative
 *  path, so re-resolve them to a workspace location; the snapshot copy itself
 *  is left untouched. The snapshot is kept when the live workspace file is
 *  gone (e.g. the source was renamed or deleted after a historical run) so
 *  "compare" doesn't abort on a missing base. Non-snapshot locations pass
 *  through unchanged. */
async function toWorkspaceOrigin(
  loc: FileLocation | null,
): Promise<FileLocation | null> {
  if (!loc || loc.kind !== 'runStorage') return loc;
  const resolved = WorkspaceFS.locatePath(loc.relativePath);
  if (
    resolved.kind !== 'workspace' ||
    !(await AbsoluteFS.isFile(resolved.absolutePath))
  ) {
    return loc;
  }
  return createWorkspaceLocation(resolved.absolutePath, resolved.relativePath);
}

// ============================================================================
// Public API
// ============================================================================

/** Computes diff stats for all output files in a round.
 *
 *  Callers in workflows must pass snapshot-resolved baseFiles (via
 *  resolveBaseFilesForDiff) when an executionId is available; passing
 *  the live workspace path would collapse in-place diffs to 0/0. The
 *  precomputedMapping, if provided, must have been built against the
 *  same snapshot-resolved baseFiles — otherwise the mapping's base
 *  locations still point at the overwritten files. */
export async function computeOutputDiffStats(
  state: OutputState,
  baseFiles: FileLocation[],
  currRound: number,
  precomputedMapping?: RoundFileMapping,
  options?: { isRewrite?: boolean },
): Promise<OutputFileInfo[]> {
  const roundOutputs = ensureRound(state, currRound);
  const mapping =
    precomputedMapping ?? traceFileLineage(state, baseFiles, currRound);
  const suppressLineage = options?.isRewrite === false;

  return Promise.all(
    roundOutputs.map(async (output) => {
      const location = output.location;
      const locationPath = getComparablePath(location);

      const baseLocation = mapping.baseToOutput.get(locationPath) ?? null;
      const originalLocation = mapping.originByOutput.get(locationPath) ?? null;

      // Use original as diff base when there's no direct base mapping
      // and the original is a different file (not self-referencing)
      let diffBaseLocation =
        baseLocation ??
        (originalLocation &&
        getComparablePath(originalLocation) !== locationPath
          ? originalLocation
          : null);

      // Fallback for single-input multi-output: when an agent extracts N
      // documents from one base file, the extracted doc names (e.g. "chapter1",
      // "methods") don't match the base filename via basename strategies.
      // If no diff base was found but there is exactly one base file, use it
      // so the diff stats reflect real changes against the original.
      if (!diffBaseLocation && !originalLocation && baseFiles.length === 1) {
        const candidate = baseFiles[0];
        if (getComparablePath(candidate) !== locationPath) {
          diffBaseLocation = candidate;
        }
      }

      const effectiveOriginal = suppressLineage
        ? null
        : await toWorkspaceOrigin(originalLocation);
      const effectiveDiffBase = suppressLineage ? null : diffBaseLocation;
      const stats = await computeDiffStats(effectiveDiffBase, location);

      return {
        source: output.source,
        round: output.round,
        location,
        lineage: {
          original: effectiveOriginal,
          diffBase: effectiveDiffBase,
          diffFile: null,
        },
        diff: stats,
      };
    }),
  );
}
