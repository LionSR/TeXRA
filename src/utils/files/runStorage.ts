// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, PlatformError } from 'effect';

import { createLog } from '@logger/logUtils';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { type RunId, type FileLocation } from '@shared/schemas';
import {
  WORKFLOW_OUTPUT_BASENAME,
  workflowOutputRoundDir,
} from '@shared/constants/workflowOutput';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  createExternalLocation,
  createRunStorageLocation,
  pathToLocationIn,
} from './fileLocation';
import { entryTypeAt } from './fsDurability';
import {
  CHANNEL,
  createSymlink,
  ensureParentDir,
  ensureRunDirUnder,
  originalSnapshotPathUnder,
  runDirUnder,
  runStorageAbsolutePathUnder,
  runStorageLocationUnder,
  shouldSkipRelocation,
  snapshotExists,
} from './runStorageFs';
import { locateInWorkspace } from './workspaceFS';

const log = createLog(CHANNEL);

/** `isFileNotFoundError` over the standard library's errors: the one reading
 *  of "nothing is there" the guards below branch on. */
const isAbsent = (error: Error): boolean =>
  error instanceof PlatformError.PlatformError &&
  error.reason._tag === 'NotFound';

export class RunFileService {
  public readonly runDirectory: string;
  private hasPreparedSnapshot = false;
  private readonly mirroredDependencies = new Set<string>();

  constructor(
    public readonly runId: RunId,
    /**
     * The run's session roots. Every workspace and storage path this service
     * resolves reads them here rather than from the calling context's roots
     * scope, which a run's Effect fiber is not guaranteed to sit inside.
     */
    private readonly roots: WorkspaceRoots,
  ) {
    this.runDirectory = runDirUnder(roots.storage, runId);
  }

  /**
   * Prepare run storage before processing begins by capturing the original
   * versions of the selected base files and mirroring any declared dependencies.
   *
   * Base files are copied into `executions/<id>/original/` as immutable snapshots
   * so the workspace can be restored even after the agent edits files in-place.
   * Additional workspace dependencies (references, auxiliaries, extracted
   * figures, etc.) are mirrored into the active run directory via symlinks so
   * tools operating inside run storage can resolve them using their
   * familiar workspace-relative paths.
   */
  public prepareRunWorkspace(
    baseFiles: FileLocation[],
    options: {
      linkFiles?: FileLocation[];
    } = {},
  ): Effect.Effect<void, Error, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      if (this.hasPreparedSnapshot) return;

      yield* ensureRunDirUnder(this.roots.storage, this.runId);

      const linkTargets = new Map<string, FileLocation>();
      for (const target of [...baseFiles, ...(options.linkFiles ?? [])]) {
        linkTargets.set(target.absolutePath, target);
      }

      yield* Effect.forEach(
        baseFiles,
        (target) => this.captureOriginalSnapshot(target),
        { concurrency: 'unbounded', discard: true },
      );

      yield* Effect.forEach(
        [...linkTargets.values()],
        (candidate) =>
          this.mirrorWorkspaceFile(candidate).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                log.warn(
                  `Failed to mirror workspace dependency ${candidate.absolutePath}: ${toErrorMessage(error)}`,
                );
              }),
            ),
          ),
        { concurrency: 'unbounded', discard: true },
      );

      this.hasPreparedSnapshot = true;
    });
  }

  /**
   * Copy a workspace file into `original/<relativePath>` if not already captured.
   * Round-dir symlinks point here rather than the live workspace so an agent
   * write at `r<N>/<relPath>` can never reach the user's working copy.
   * Idempotent; skips non-workspace, ignored-root, non-regular, and missing sources.
   */
  private captureOriginalSnapshot(
    target: FileLocation,
  ): Effect.Effect<void, Error, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      if (target.kind !== 'workspace') return;
      if (shouldSkipRelocation(target.relativePath)) return;

      const fs = yield* FileSystem.FileSystem;
      const stats = yield* fs.stat(target.absolutePath);
      if (stats.type !== 'File') return;

      const snapshotAbsolute = originalSnapshotPathUnder(
        this.roots.storage,
        this.runId,
        target.relativePath,
      );

      if (yield* snapshotExists(snapshotAbsolute)) return;

      yield* ensureParentDir(snapshotAbsolute);
      yield* fs.copyFile(target.absolutePath, snapshotAbsolute);
    }).pipe(
      Effect.catch((error) =>
        isAbsent(error)
          ? Effect.void
          : Effect.fail(
              new Error(
                `Failed to capture original file ${target.absolutePath}: ${toErrorMessage(error)}`,
                { cause: error },
              ),
            ),
      ),
    );
  }

  /** Create a FileLocation for a workflow output file. */
  public createLocation(inputPath: string): FileLocation {
    const runStorageLocation = runStorageLocationUnder(
      this.roots.storage,
      inputPath,
    );
    if (runStorageLocation) return runStorageLocation;

    const resolved = locateInWorkspace(this.roots.workspace, inputPath);

    if (resolved.kind === 'external') {
      return createExternalLocation(resolved.absolutePath);
    }

    const runAbsolute = runStorageAbsolutePathUnder(
      this.roots.storage,
      this.runId,
      resolved.relativePath,
    );
    return createRunStorageLocation(
      runAbsolute,
      resolved.relativePath,
      this.runId,
    );
  }

  /** Preserve the storage provenance of an existing input or comparison base. */
  public locateSource(inputPath: string): FileLocation {
    return (
      runStorageLocationUnder(this.roots.storage, inputPath) ??
      pathToLocationIn(this.roots.workspace, inputPath)
    );
  }

  /**
   * Ensure a workspace dependency is reachable from run storage via symlink.
   * Takes a FileLocation and creates a symlink in run storage if needed.
   *
   * Pass `snapshot: true` for editable inputs so the file is also copied into
   * `original/<relPath>`; round-dir symlinks then point there rather than
   * chaining back to the live workspace.
   */
  public mirrorWorkspaceFile(
    location: FileLocation,
    options: { snapshot?: boolean } = {},
  ): Effect.Effect<FileLocation, Error, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      if (
        location.kind !== 'workspace' ||
        shouldSkipRelocation(location.relativePath)
      ) {
        return location;
      }

      yield* ensureRunDirUnder(this.roots.storage, this.runId);
      const runAbsolute = runStorageAbsolutePathUnder(
        this.roots.storage,
        this.runId,
        location.relativePath,
      );

      if (!this.mirroredDependencies.has(location.relativePath)) {
        yield* createSymlink(location.absolutePath, runAbsolute);
        this.mirroredDependencies.add(location.relativePath);
      }

      if (options.snapshot) {
        yield* this.captureOriginalSnapshot(location);
      }

      return createRunStorageLocation(
        runAbsolute,
        location.relativePath,
        this.runId,
      );
    });
  }

  /**
   * For every mirrored top-level dependency, ensure a symlink also exists at
   * `<runDir>/r{round}/<relativePath>`. This lets `latexmk`, `pdflatex`, and
   * `latexdiff` run with `cwd = runDir/r{round}` and resolve `\input{foo}`
   * against sibling symlinks. Idempotent; safe to call every round.
   *
   * Collisions with primary workflow artifacts are skipped:
   *   - `output.{ext}` at runDir root (the fixed round-output basename from
   *     `WORKFLOW_OUTPUT_BASENAME`).
   *   - Any existing real file at the destination — e.g. an extracted
   *     multi-document output written to `r{round}/<source>.tex` by the
   *     XML output manager when the same path is also an `\input`
   *     dependency. Replacing that real file with a symlink to the
   *     original workspace source would silently destroy the round's
   *     revised content.
   */
  public ensureMirroredInRoundDir(
    round: number,
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    return this.ensureMirroredInRunSubdir(workflowOutputRoundDir(round), {
      protectPrimaryOutput: true,
    });
  }

  /**
   * Ensure mirrored workspace dependencies are also reachable from
   * `<runDir>/diff/r{round}/...`, where workflow latexdiff sources and build
   * artifacts live.
   */
  public ensureMirroredInDiffRoundDir(
    round: number,
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    return this.ensureMirroredInRunSubdir(
      path.join('diff', workflowOutputRoundDir(round)),
      { protectPrimaryOutput: false },
    );
  }

  private ensureMirroredInRunSubdir(
    relativeDirectory: string,
    options: { protectPrimaryOutput: boolean },
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      if (this.mirroredDependencies.size === 0) return;

      const fs = yield* FileSystem.FileSystem;
      yield* Effect.forEach(
        [...this.mirroredDependencies],
        (relativePath) =>
          Effect.gen({ self: this }, function* () {
            // A dep whose path ends at `output.{ext}` (no subdirectory within
            // the round) would symlink over the primary revised output that
            // lives at `r{round}/output.{ext}`. `createSymlink` replaces any
            // existing entry on EEXIST, so an unguarded mirror would silently
            // destroy the round's result. Skip these — the dependency is still
            // reachable at `r{round}/../<relativePath>`, i.e.
            // `<runDir>/<relativePath>`.
            const { dir: depDir, name: depName } = path.parse(relativePath);
            if (
              options.protectPrimaryOutput &&
              depDir === '' &&
              depName === WORKFLOW_OUTPUT_BASENAME
            ) {
              log.debug(
                `Skipping run-dir mirror of ${relativePath}: would clobber primary output in ${relativeDirectory}`,
              );
              return;
            }

            // Prefer the immutable `original/` snapshot as the symlink source
            // for editable inputs, so the chain `r<N>/<rel> → original/<rel>`
            // never reaches the live workspace. Read-only build assets
            // (cls/sty/bib/figures) have no snapshot and fall through to the
            // workspace mirror at `runDir/<rel>`, which is correct — those
            // are never written to.
            const snapshotAbsolute = originalSnapshotPathUnder(
              this.roots.storage,
              this.runId,
              relativePath,
            );
            const workspaceMirrorAbsolute = runStorageAbsolutePathUnder(
              this.roots.storage,
              this.runId,
              relativePath,
            );
            // No snapshot is the ordinary case for a read-only build asset.
            // Any other failure means the round dir links the live workspace
            // mirror in place of the pristine snapshot, which a later diff or
            // revert would read as the base.
            const hasSnapshot = yield* fs.stat(snapshotAbsolute).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.sync(() => {
                  if (!isAbsent(error)) {
                    log.warn(
                      `Unable to stat snapshot ${snapshotAbsolute}; linking the workspace mirror instead: ${toErrorMessage(error)}`,
                    );
                  }
                  return false;
                }),
              ),
            );
            const sourceAbsolute = hasSnapshot
              ? snapshotAbsolute
              : workspaceMirrorAbsolute;
            const destinationAbsolute = runStorageAbsolutePathUnder(
              this.roots.storage,
              this.runId,
              path.join(relativeDirectory, relativePath),
            );

            // Guard against clobbering a real file already written to the
            // round dir — e.g. a multi-document extracted output at
            // `r{round}/chapters/ch1.tex` when `chapters/ch1.tex` is also an
            // `\input` dependency. A stale symlink from a previous call is
            // safe to replace (idempotent); anything else must be preserved.
            // Absence is the common case — no collision, proceed with the
            // link. Any other failure leaves the collision unknown, and
            // linking then replaces an EEXIST destination outright, so the
            // guard fails closed rather than disarming itself.
            const destination = yield* entryTypeAt(destinationAbsolute).pipe(
              Effect.map((type) =>
                type === 'SymbolicLink' ? 'staleLink' : 'realFile',
              ),
              Effect.catch((error) =>
                Effect.sync(() => {
                  if (isAbsent(error)) return 'absent' as const;
                  log.warn(
                    `Skipping run-dir mirror of ${relativePath}: cannot stat the destination in ${relativeDirectory}: ${toErrorMessage(error)}`,
                  );
                  return 'unreadable' as const;
                }),
              ),
            );
            if (destination === 'realFile') {
              log.debug(
                `Skipping run-dir mirror of ${relativePath}: destination in ${relativeDirectory} is an existing real file`,
              );
              return;
            }
            if (destination === 'unreadable') return;

            yield* createSymlink(sourceAbsolute, destinationAbsolute).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  log.warn(
                    `Unable to mirror ${relativePath} into ${relativeDirectory}: ${toErrorMessage(error)}`,
                  );
                }),
              ),
            );
          }),
        { concurrency: 'unbounded', discard: true },
      );
    });
  }
}
