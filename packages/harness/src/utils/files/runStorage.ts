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
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
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

/** `createSymlink`'s refusal to replace an entry that is not a link. */
const isStanding = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === 'AlreadyExists';

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
  /** One lane per workspace-relative path: its snapshot and its mirror are
   *  each checked and created by one fiber at a time. */
  private readonly pathLanes = new Map<string, PerKeyLane>();
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
      return yield* Effect.gen(function* () {
        if (yield* snapshotExists(snapshotAbsolute)) return snapshot;

        const fs = yield* FileSystem.FileSystem;
        const stats = yield* fs.stat(target.absolutePath);
        if (stats.type !== 'File') return target;

        yield* ensureParentDir(snapshotAbsolute);
        yield* fs.copyFile(target.absolutePath, snapshotAbsolute);
        return snapshot;
      }).pipe(withPerKeyLane(this.pathLanes, target.relativePath));
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

      const mirrored = this.mirroredDependencies;
      // Checked and linked on the path's lane: two mirrors of one dependency
      // never both create it. A file standing at the path is the run's own.
      yield* Effect.suspend(() =>
        mirrored.has(location.relativePath)
          ? Effect.void
          : createSymlink(location.absolutePath, runAbsolute).pipe(
              Effect.catchIf(isStanding, () => Effect.void),
              Effect.andThen(
                Effect.sync(() => {
                  mirrored.add(location.relativePath);
                }),
              ),
            ),
      ).pipe(withPerKeyLane(this.pathLanes, location.relativePath));

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
            // A root dep named as the directory's own artifact would take its
            // path before the artifact is written there. Skip these; the
            // dependency is still reachable at
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
            // Any other failure means the round dir links the live workspace
            // mirror in place of the pristine snapshot, which a later diff or
            // revert would read as the base.
            const hasSnapshot = yield* fs.stat(snapshotAbsolute).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                isAbsent(error)
                  ? Effect.succeed(false)
                  : Effect.logWarning(
                      `Unable to stat snapshot ${snapshotAbsolute}; linking the workspace mirror instead: ${toErrorMessage(error)}`,
                    ).pipe(withLogChannel(CHANNEL), Effect.as(false)),
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

            // A stale link from a previous call is replaced (idempotent); a
            // real file already written to the round dir (a multi-document
            // output at `r{round}/chapters/ch1.md` when `chapters/ch1.md` is
            // also an include dependency) stands: `createSymlink` refuses it.
            yield* createSymlink(sourceAbsolute, destinationAbsolute).pipe(
              Effect.catch((error) =>
                isStanding(error)
                  ? Effect.logDebug(
                      `Skipping run-dir mirror of ${relativePath}: destination in ${relativeDirectory} is an existing real file`,
                    )
                  : Effect.logWarning(
                      `Unable to mirror ${relativePath} into ${relativeDirectory}: ${toErrorMessage(error)}`,
                    ),
              ),
              withLogChannel(CHANNEL),
            );
          }),
        { concurrency: 'unbounded', discard: true },
      );
    });
  }
}
