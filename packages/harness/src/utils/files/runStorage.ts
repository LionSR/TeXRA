// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, PlatformError } from 'effect';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { withLogChannel } from '@logger/effectLog';
import {
  type RunId,
  type FileLocation,
  type RunStorageFileLocation,
} from '@shared/schemas';
import { normalizeFilePath } from '@utils/core';
import { getPathSegments } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  createExternalLocation,
  createRunStorageLocation,
  pathToLocationIn,
} from './fileLocation';
import { entryExists, entryTypeIn } from './fsEntryExists';
import {
  CHANNEL,
  createSymlink,
  ensureParentDir,
  ensureRunDirUnder,
  runDirUnder,
  runStorageAbsolutePathUnder,
  runStorageLocationUnder,
  shouldSkipRelocation,
  snapshotExists,
} from './runStorageFs';
import { locateInWorkspace } from './workspaceFS';

/** `isFileNotFoundError` over the standard library's errors: the one reading
 *  of "nothing is there" the guards below branch on. */
const isAbsent = (error: Error): boolean =>
  error instanceof PlatformError.PlatformError &&
  error.reason._tag === 'NotFound';

/** One run-relative entry of a run's storage, read without following a link. */
export type RunStorageEntry =
  | { readonly kind: 'file'; readonly location: RunStorageFileLocation }
  | {
      readonly kind: 'symlink' | 'directory' | 'unsupported';
      readonly absolutePath: string;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string };

export class RunFileService {
  public readonly runDirectory: string;
  /** The base files' pre-run locations, decided by `prepareRunWorkspace`. */
  private preparedBaseFiles: FileLocation[] | undefined;
  private readonly mirroredDependencies = new Set<string>();
  /** The files the run read, which an edit of one needs; read-only here. */
  public readonly readFiles: ReadonlySet<string> = new Set<string>();

  constructor(
    public readonly runId: RunId,
    /**
     * The run's session roots. Every workspace and storage path this service
     * resolves reads them here rather than from the calling context's roots
     * scope, which a run's Effect fiber is not guaranteed to sit inside.
     */
    private readonly roots: {
      readonly storage: string;
      readonly workspace: string | undefined;
    },
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
   *
   * Answers each base file's pre-run location, in order: its snapshot when
   * one exists, else the file itself. That list is what a diff compares
   * against for the whole run; a resumed run re-prepares and gets the
   * snapshots its first attempt captured.
   */
  public prepareRunWorkspace(
    baseFiles: FileLocation[],
    options: {
      linkFiles?: FileLocation[];
    } = {},
  ): Effect.Effect<FileLocation[], Error, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      if (this.preparedBaseFiles) return this.preparedBaseFiles;

      yield* ensureRunDirUnder(this.roots.storage, this.runId);

      const linkTargets = new Map<string, FileLocation>();
      for (const target of [...baseFiles, ...(options.linkFiles ?? [])]) {
        linkTargets.set(target.absolutePath, target);
      }

      const prepared = yield* Effect.forEach(
        baseFiles,
        (target) => this.captureOriginalSnapshot(target),
        { concurrency: 'unbounded' },
      );

      // Best-effort, per dependency: the snapshots above are the run's diff
      // base and have already landed, while a missing mirror costs only that
      // one file's reachability from run storage (a build there reports the
      // unresolved include itself). Failing the whole preparation would
      // instead discard every snapshot. A missing source is not a failure
      // here (a symlink needs no target), so whatever lands in this catch is
      // a real I/O error, warned with its path and cause.
      yield* Effect.forEach(
        [...linkTargets.values()],
        (candidate) =>
          this.mirrorWorkspaceFile(candidate).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Failed to mirror workspace dependency ${candidate.absolutePath}: ${toErrorMessage(error)}`,
              ).pipe(withLogChannel(CHANNEL)),
            ),
          ),
        { concurrency: 'unbounded', discard: true },
      );

      this.preparedBaseFiles = prepared;
      return prepared;
    });
  }

  /**
   * Copy a workspace file into `original/<relativePath>` if not already
   * captured, and answer where its pre-run content lives: the snapshot when
   * one exists (captured now or by an earlier attempt of this run), else the
   * target itself.
   * Round-dir symlinks point here rather than the live workspace so an agent
   * write at `r<N>/<relPath>` can never reach the user's working copy.
   * Idempotent; skips non-workspace, ignored-root, non-regular, and missing sources.
   */
  private captureOriginalSnapshot(
    target: FileLocation,
  ): Effect.Effect<FileLocation, Error, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      if (target.kind !== 'workspace') return target;
      if (shouldSkipRelocation(target.relativePath)) return target;

      const snapshotAbsolute = this.originalSnapshotPath(target.relativePath);
      const snapshot = createRunStorageLocation(
        snapshotAbsolute,
        target.relativePath,
        this.runId,
      );
      if (yield* snapshotExists(snapshotAbsolute)) return snapshot;

      const fs = yield* FileSystem.FileSystem;
      const stats = yield* fs.stat(target.absolutePath);
      if (stats.type !== 'File') return target;

      yield* ensureParentDir(snapshotAbsolute);
      yield* fs.copyFile(target.absolutePath, snapshotAbsolute);
      return snapshot;
    }).pipe(
      Effect.catch((error) =>
        isAbsent(error)
          ? Effect.succeed(target)
          : Effect.fail(
              new Error(
                `Failed to capture original file ${target.absolutePath}: ${toErrorMessage(error)}`,
                { cause: error },
              ),
            ),
      ),
    );
  }

  /** Whether this run has a directory under its storage root. */
  public hasDirectory(): Effect.Effect<
    boolean,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    return Effect.gen({ self: this }, function* () {
      return yield* entryExists(
        yield* FileSystem.FileSystem,
        this.runDirectory,
      );
    });
  }

  /** Where a workspace file's pre-run snapshot lives in this run. */
  public originalSnapshotPath(workspaceRelativePath: string): string {
    return path.join(
      this.runDirectory,
      WORKSPACE_STORAGE_LAYOUT.original,
      workspaceRelativePath,
    );
  }

  /**
   * Inspect one run-relative entry of this run's storage without following
   * a workspace-mirror symlink, the entry's own or an ancestor directory's.
   */
  public inspectEntry(
    relativePath: string,
  ): Effect.Effect<
    RunStorageEntry,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    return Effect.gen({ self: this }, function* () {
      const fs = yield* FileSystem.FileSystem;
      const posixPath = normalizeFilePath(relativePath);
      const pathSegments = getPathSegments(posixPath);
      if (
        pathSegments.length === 0 ||
        path.posix.isAbsolute(posixPath) ||
        path.win32.isAbsolute(relativePath) ||
        pathSegments.includes('..')
      ) {
        return {
          kind: 'invalid',
          reason:
            'Run-storage paths must be non-empty relative paths without parent traversal.',
        } as const;
      }
      const normalizedPath = path.posix.normalize(posixPath);
      // Every directory the walk descends through, run root first, with the
      // entry's own path excluded: one path per prefix of `pathSegments`.
      const ancestors = [
        this.runDirectory,
        ...pathSegments
          .slice(0, -1)
          .map((_, index) =>
            path.join(this.runDirectory, ...pathSegments.slice(0, index + 1)),
          ),
      ];
      for (const ancestor of ancestors) {
        const ancestorType = yield* entryTypeIn(fs, ancestor);
        if (ancestorType === undefined) return { kind: 'missing' } as const;
        if (ancestorType === 'SymbolicLink') {
          return { kind: 'symlink', absolutePath: ancestor } as const;
        }
        if (ancestorType !== 'Directory') {
          return { kind: 'unsupported', absolutePath: ancestor } as const;
        }
      }

      const absolutePath = path.join(this.runDirectory, normalizedPath);
      const type = yield* entryTypeIn(fs, absolutePath);
      if (type === undefined) return { kind: 'missing' } as const;
      if (type === 'SymbolicLink') {
        return { kind: 'symlink', absolutePath } as const;
      }
      if (type === 'File') {
        return {
          kind: 'file',
          location: createRunStorageLocation(
            absolutePath,
            normalizedPath,
            this.runId,
          ),
        } as const;
      }
      if (type === 'Directory') {
        return { kind: 'directory', absolutePath } as const;
      }
      return { kind: 'unsupported', absolutePath } as const;
    });
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
   * `<runDir>/<relativeDirectory>/<relativePath>`, so a build tool run there
   * with that `cwd` resolves a relative include of `foo` against sibling
   * symlinks. Idempotent; safe to call every time.
   *
   * Collisions with the caller's own artifacts are skipped:
   *   - a dependency at runDir root named `options.protectedStem` (any
   *     extension), which would symlink over the artifact of that name the
   *     directory holds;
   *   - any existing real file at the destination, which a symlink to the
   *     original workspace source would silently destroy.
   */
  public ensureMirroredInRunSubdir(
    relativeDirectory: string,
    options: { readonly protectedStem?: string } = {},
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      if (this.mirroredDependencies.size === 0) return;

      const fs = yield* FileSystem.FileSystem;
      yield* Effect.forEach(
        [...this.mirroredDependencies],
        (relativePath) =>
          Effect.gen({ self: this }, function* () {
            // A root dep named as the directory's own artifact would symlink
            // over it: `createSymlink` replaces any existing entry on EEXIST,
            // so an unguarded mirror would silently destroy it. Skip these;
            // the dependency is still reachable at
            // `<relativeDirectory>/../<relativePath>`.
            const { dir: depDir, name: depName } = path.parse(relativePath);
            if (depDir === '' && depName === options.protectedStem) {
              yield* Effect.logDebug(
                `Skipping run-dir mirror of ${relativePath}: would clobber primary output in ${relativeDirectory}`,
              ).pipe(withLogChannel(CHANNEL));
              return;
            }

            // Prefer the immutable `original/` snapshot as the symlink source
            // for editable inputs, so the chain `r<N>/<rel> → original/<rel>`
            // never reaches the live workspace. Read-only build assets
            // (cls/sty/bib/figures) have no snapshot and fall through to the
            // workspace mirror at `runDir/<rel>`, which is correct — those
            // are never written to.
            const snapshotAbsolute = this.originalSnapshotPath(relativePath);
            const workspaceMirrorAbsolute = runStorageAbsolutePathUnder(
              this.roots.storage,
              this.runId,
              relativePath,
            );
            // No snapshot is the ordinary case for a read-only build asset.
            // Any other failure leaves unknown whether one exists, and
            // linking the workspace mirror then could hand an agent write at
            // `r<N>/<rel>` the user's working copy, so this dependency is
            // left unlinked, as the destination guard below does.
            const snapshot = yield* snapshotExists(snapshotAbsolute).pipe(
              Effect.map((exists) =>
                exists ? ('present' as const) : ('absent' as const),
              ),
              Effect.catch((error) =>
                Effect.logWarning(
                  `Skipping run-dir mirror of ${relativePath}: ${toErrorMessage(error)}`,
                ).pipe(
                  withLogChannel(CHANNEL),
                  Effect.as('unreadable' as const),
                ),
              ),
            );
            if (snapshot === 'unreadable') return;
            const sourceAbsolute =
              snapshot === 'present'
                ? snapshotAbsolute
                : workspaceMirrorAbsolute;
            const destinationAbsolute = runStorageAbsolutePathUnder(
              this.roots.storage,
              this.runId,
              path.join(relativeDirectory, relativePath),
            );

            // Guard against clobbering a real file already written to the
            // round dir — e.g. a multi-document extracted output at
            // `r{round}/chapters/ch1.md` when `chapters/ch1.md` is also an
            // include dependency. A stale symlink from a previous call is
            // safe to replace (idempotent); anything else must be preserved.
            // Absence is the common case — no collision, proceed with the
            // link. Any other failure leaves the collision unknown, and
            // linking then replaces an EEXIST destination outright, so the
            // guard fails closed rather than disarming itself.
            const destination = yield* entryTypeIn(
              fs,
              destinationAbsolute,
            ).pipe(
              Effect.map((type) => {
                if (type === undefined) return 'absent' as const;
                return type === 'SymbolicLink'
                  ? ('staleLink' as const)
                  : ('realFile' as const);
              }),
              Effect.catch((error) =>
                Effect.logWarning(
                  `Skipping run-dir mirror of ${relativePath}: cannot stat the destination in ${relativeDirectory}: ${toErrorMessage(error)}`,
                ).pipe(
                  withLogChannel(CHANNEL),
                  Effect.as('unreadable' as const),
                ),
              ),
            );
            if (destination === 'realFile') {
              yield* Effect.logDebug(
                `Skipping run-dir mirror of ${relativePath}: destination in ${relativeDirectory} is an existing real file`,
              ).pipe(withLogChannel(CHANNEL));
              return;
            }
            if (destination === 'unreadable') return;

            yield* createSymlink(sourceAbsolute, destinationAbsolute).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `Unable to mirror ${relativePath} into ${relativeDirectory}: ${toErrorMessage(error)}`,
                ).pipe(withLogChannel(CHANNEL)),
              ),
            );
          }),
        { concurrency: 'unbounded', discard: true },
      );
    });
  }
}
