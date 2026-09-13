/**
 * Diff statistics computation for output files.
 *
 * Computes line-based diff statistics between base files and outputs
 * using the diff-match-patch library.
 */

import { Effect } from 'effect';

import { isFileNotFoundError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import {
  fileLocationDisplayPath,
  type DiffStats,
  type FileLocation,
  type OutputFileInfo,
} from '@shared/schemas';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { createWorkspaceLocation } from '@utils/files/fileLocation';
import { locateInWorkspace } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { diffLineChanges } from '@utils/text/diff';
import { countLines } from '@utils/text/stringUtils';

import { traceFileLineage } from './lineageMapping';
import { fsCall } from './outputOperations';
import { ensureRoundData, type OutputState } from './outputState';
import type { RoundFileMapping } from './types';

const log = createLog('OutputDiffStats');

// ============================================================================
// Helpers
// ============================================================================

/** Computes diff statistics between base and output files. */
function computeDiffStats(
  baseLocation: FileLocation | null,
  outputLocation: FileLocation,
): Effect.Effect<DiffStats> {
  const read = (absolutePath: string) =>
    fsCall(() => AbsoluteFS.read(absolutePath));
  return Effect.gen(function* () {
    if (!baseLocation) {
      const outContent = yield* read(outputLocation.absolutePath);
      return { added: countLines(outContent) };
    }

    const [baseContent, outContent] = yield* Effect.all(
      [read(baseLocation.absolutePath), read(outputLocation.absolutePath)],
      { concurrency: 2 },
    );

    return diffLineChanges(baseContent, outContent);
  }).pipe(
    // An unreadable side of the pair yields no stats rather than failing the
    // round, but never silently: a missing file is expected on a historical
    // run and logged at debug, anything else at warn.
    Effect.catch((err) =>
      Effect.sync((): DiffStats => {
        const message = `Failed to compute diff stats: ${toErrorMessage(err)}`;
        if (isFileNotFoundError(err)) {
          log.debug(message);
        } else {
          log.warn(message);
        }
        return {};
      }),
    ),
  );
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
function toWorkspaceOrigin(
  workspace: string | undefined,
  loc: FileLocation | null,
): Effect.Effect<FileLocation | null, Error> {
  return Effect.gen(function* () {
    if (!loc || loc.kind !== 'runStorage') return loc;
    const resolved = locateInWorkspace(workspace, loc.relativePath);
    if (
      resolved.kind !== 'workspace' ||
      !(yield* fsCall(() => AbsoluteFS.isFile(resolved.absolutePath)))
    ) {
      return loc;
    }
    return createWorkspaceLocation(
      resolved.absolutePath,
      resolved.relativePath,
    );
  });
}

// ============================================================================
// Public API
// ============================================================================

/** Computes diff stats for all output files in a round.
 *
 *  Callers in workflows must pass snapshot-resolved baseFiles (via
 *  resolveBaseFilesForDiff); passing the live workspace path would
 *  collapse in-place diffs to 0/0. The precomputedMapping, if provided,
 *  must have been built against the same snapshot-resolved baseFiles —
 *  otherwise the mapping's base locations still point at the overwritten
 *  files. */
export const computeOutputDiffStats = Effect.fn(
  'reflection.computeOutputDiffStats',
)(function* (
  state: OutputState,
  /** The run's workspace root, which a snapshot's lineage re-resolves to. */
  workspace: string | undefined,
  baseFiles: FileLocation[],
  currRound: number,
  precomputedMapping?: RoundFileMapping,
  options?: { isRewrite?: boolean },
) {
  const roundOutputs = ensureRoundData(state, currRound).outputs;
  const mapping =
    precomputedMapping ?? traceFileLineage(state, baseFiles, currRound);
  const suppressLineage = options?.isRewrite === false;

  return yield* Effect.forEach(
    roundOutputs,
    (output) =>
      Effect.gen(function* (): Generator<
        Effect.Effect<unknown, Error>,
        OutputFileInfo
      > {
        const location = output.location;
        const locationPath = fileLocationDisplayPath(location);

        const entry = mapping.get(locationPath);
        const originalLocation = entry?.origin ?? null;
        // `traceFileLineage` coalesces `base: origin ?? …`, so an entry with
        // an origin always carries a base: there is no "origin but no base"
        // case left to fall back on, and `!diffBaseLocation` implies no
        // origin.
        let diffBaseLocation = entry?.base ?? null;

        // Fallback for single-input multi-output: when an agent extracts N
        // documents from one base file, the extracted doc names (e.g.
        // "chapter1", "methods") don't match the base filename via basename
        // strategies. If no diff base was found but there is exactly one base
        // file, use it so the diff stats reflect real changes against the
        // original.
        if (!diffBaseLocation && baseFiles.length === 1) {
          const candidate = baseFiles[0];
          if (fileLocationDisplayPath(candidate) !== locationPath) {
            diffBaseLocation = candidate;
          }
        }

        const effectiveOriginal = suppressLineage
          ? null
          : yield* toWorkspaceOrigin(workspace, originalLocation);
        const effectiveDiffBase = suppressLineage ? null : diffBaseLocation;
        const stats = yield* computeDiffStats(effectiveDiffBase, location);

        return {
          source: output.source,
          round: output.round,
          location,
          lineage: {
            original: effectiveOriginal,
            diffBase: effectiveDiffBase,
          },
          diff: stats,
        };
      }),
    { concurrency: 'unbounded' },
  );
});
