/**
 * Diff statistics computation for output files.
 *
 * Computes line-based diff statistics between base files and outputs
 * using the diff-match-patch library.
 */

import { diff_match_patch } from 'diff-match-patch';

import type { OutputFileInfo, FileLocation } from '@shared/schemas';
import type { DiffStats } from '@agent/types/DiffTypes';
import { flexibleFS, getComparablePath } from '@utils/files';
import { countLines } from '@utils/text/stringUtils';

import { traceFileLineage } from './lineageMapping';
import { ensureRound, type OutputState } from './outputState';
import type { RoundFileMapping } from './types';

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
    // Log the failure for debugging - don't swallow silently
    console.debug?.('Failed to compute diff stats:', err);
    return {};
  }
}

// ============================================================================
// Public API
// ============================================================================

/** Computes diff stats for all output files in a round. */
export async function computeOutputDiffStats(
  state: OutputState,
  baseFiles: FileLocation[],
  currRound: number,
  precomputedMapping?: RoundFileMapping,
): Promise<OutputFileInfo[]> {
  const roundOutputs = ensureRound(state, currRound);
  const mapping =
    precomputedMapping ?? traceFileLineage(state, baseFiles, currRound);

  return Promise.all(
    roundOutputs.map(async (output) => {
      const location = output.location;
      const locationPath = getComparablePath(location);

      const baseLocation = mapping.baseToOutput.get(locationPath) ?? null;
      const originalLocation = mapping.originByOutput.get(locationPath) ?? null;

      const useOriginalAsDiffBase =
        !baseLocation &&
        originalLocation &&
        getComparablePath(originalLocation) !== locationPath;
      const diffBaseLocation = useOriginalAsDiffBase
        ? originalLocation
        : baseLocation;

      const stats = await computeDiffStats(diffBaseLocation, location);

      return {
        source: output.source,
        round: output.round,
        location,
        lineage: {
          original: originalLocation,
          diffBase: diffBaseLocation,
          diffFile: null,
        },
        diff: stats,
      };
    }),
  );
}
