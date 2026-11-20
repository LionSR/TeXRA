/**
 * A document task run's workspace in its run storage: the pre-run snapshots
 * of the files it rewrites, the workspace dependencies it mirrors so a build
 * in run storage resolves them, and the round directories' links to both.
 * One per run activation (`runWorkspaceOf`), since what it has mirrored is
 * what later calls of the run link into a round directory.
 */

// Standard library imports
import * as path from 'node:path';

// Third-party imports
import {
  Effect,
  FileSystem,
  Schema,
  type PlatformError,
  type Scope,
} from 'effect';

// Local imports
import { meansAbsent, createSymlink } from '@texra-ai/harness/node';
import {
  runDirUnder,
  sourceLocationUnder,
  withLogChannel,
  withFileWriteLane,
} from '@texra-ai/harness/plugins';
import {
  type FileLocation,
  type RunId,
  toErrorMessage,
} from '@texra-ai/harness/schemas';

const CHANNEL = 'runStorage';

/** A base file's pre-run snapshot could not be inspected or captured. */
class SnapshotCaptureFailed extends Schema.TaggedError<SnapshotCaptureFailed>()(
  'SnapshotCaptureFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The directory under a run's storage that holds its pre-run snapshots. */
const ORIGINAL_DIR = 'original';

/** `createSymlink`'s refusal to replace an entry that is not a link. */
const isStanding = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === 'AlreadyExists';

/** The roots a run workspace resolves its paths against, held as data. */
interface WorkspaceRootsOf {
  readonly storage: string;
  readonly workspace: string | undefined;
}

export class RunWorkspace {
  readonly runDirectory: string;
  readonly runId: RunId;
  /** The base files' pre-run locations, decided by `prepareRunWorkspace`. */
  private preparedBaseFiles: FileLocation[] | undefined;
  private readonly mirroredDependencies = new Set<string>();
  private readonly roots: WorkspaceRootsOf;

  constructor(runId: RunId, roots: WorkspaceRootsOf) {
    this.runId = runId;
    this.roots = roots;
    this.runDirectory = runDirUnder(roots.storage, runId);
  }

  /** The run's directory, created with the runs directory if absent. */
  private readonly ensureRunDirectory = FileSystem.FileSystem.use((fs) =>
    fs.makeDirectory(this.runDirectory, { recursive: true }),
  );

  /** An absolute path inside the run's directory. */
  private inRunDirectory(relativePath: string): string {
    return path.join(this.runDirectory, relativePath);
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
  readonly prepareRunWorkspace = Effect.fn('RunWorkspace.prepare')(
    { self: this },
    function* (
      baseFiles: FileLocation[],
      options: {
        linkFiles?: FileLocation[];
      } = {},
    ): Effect.fn.Return<
      FileLocation[],
      SnapshotCaptureFailed | PlatformError.PlatformError,
      FileSystem.FileSystem
    > {
      if (this.preparedBaseFiles) return this.preparedBaseFiles;

      yield* this.ensureRunDirectory;

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
    },
  );

  /**
   * Copy a workspace file into `original/<relativePath>` if not already
   * captured, and answer where its pre-run content lives: the snapshot when
   * one exists (captured now or by an earlier attempt of this run), else the
   * target itself.
   * Round-dir symlinks point here rather than the live workspace so an agent
   * write at `r<N>/<relPath>` can never reach the user's working copy.
   * Idempotent; skips non-workspace, non-regular, and missing sources.
   */
  private captureOriginalSnapshot(
    target: FileLocation,
  ): Effect.Effect<FileLocation, SnapshotCaptureFailed, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      if (target.kind !== 'workspace') return target;

      const snapshotAbsolute = this.originalSnapshotPath(target.relativePath);
      const snapshot: FileLocation = {
        kind: 'runStorage',
        absolutePath: snapshotAbsolute,
        relativePath: target.relativePath,
        runId: this.runId,
      };
      // Checked and copied as the snapshot's one writer: two captures of
      // one file never both copy it.
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Only absence reads as "no snapshot": any other stat failure fails the
        // capture, so a permissions error never silently forces a re-copy over a
        // real snapshot.
        const hasSnapshot = yield* fs.stat(snapshotAbsolute).pipe(
          Effect.as(true),
          Effect.catchIf(meansAbsent, () => Effect.succeed(false)),
          Effect.mapError(
            (error) =>
              new SnapshotCaptureFailed({
                message: `Failed to inspect snapshot destination ${snapshotAbsolute}: ${toErrorMessage(error)}`,
                cause: error,
              }),
          ),
        );
        if (hasSnapshot) return snapshot;

        const stats = yield* fs.stat(target.absolutePath);
        if (stats.type !== 'File') return target;

        yield* fs.makeDirectory(path.dirname(snapshotAbsolute), {
          recursive: true,
        });
        yield* fs.copyFile(target.absolutePath, snapshotAbsolute);
        return snapshot;
      }).pipe(withFileWriteLane(snapshotAbsolute));
    }).pipe(
      Effect.catch((error) =>
        meansAbsent(error)
          ? Effect.succeed(target)
          : Effect.fail(
              new SnapshotCaptureFailed({
                message: `Failed to capture original file ${target.absolutePath}: ${toErrorMessage(error)}`,
                cause: error,
              }),
            ),
      ),
    );
  }

  /** Where a workspace file's pre-run snapshot lives in this run. */
  originalSnapshotPath(workspaceRelativePath: string): string {
    return path.join(this.runDirectory, ORIGINAL_DIR, workspaceRelativePath);
  }

  /**
   * The location a declared output is written to: a path already in run
   * storage, or outside the workspace, stays where it is; a workspace path is
   * written at the same relative path in this run's directory.
   */
  createLocation(inputPath: string): FileLocation {
    const source = sourceLocationUnder(this.roots, inputPath);
    if (source.kind !== 'workspace') return source;
    return {
      kind: 'runStorage',
      absolutePath: this.inRunDirectory(source.relativePath),
      relativePath: source.relativePath,
      runId: this.runId,
    };
  }

  /**
   * Ensure a workspace dependency is reachable from run storage via symlink.
   * Takes a FileLocation and creates a symlink in run storage if needed.
   *
   * Pass `snapshot: true` for editable inputs so the file is also copied into
   * `original/<relPath>`; round-dir symlinks then point there rather than
   * chaining back to the live workspace.
   */
  readonly mirrorWorkspaceFile = Effect.fn('RunWorkspace.mirrorWorkspaceFile')(
    { self: this },
    function* (
      location: FileLocation,
      options: { snapshot?: boolean } = {},
    ): Effect.fn.Return<
      FileLocation,
      SnapshotCaptureFailed | PlatformError.PlatformError,
      FileSystem.FileSystem
    > {
      if (location.kind !== 'workspace') return location;

      yield* this.ensureRunDirectory;
      const runAbsolute = this.inRunDirectory(location.relativePath);

      const mirrored = this.mirroredDependencies;
      // Checked and linked as the link's one writer: two mirrors of one
      // dependency never both create it. A file standing at the path is the
      // run's own.
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
      ).pipe(withFileWriteLane(runAbsolute));

      if (options.snapshot) {
        yield* this.captureOriginalSnapshot(location);
      }

      return {
        kind: 'runStorage',
        absolutePath: runAbsolute,
        relativePath: location.relativePath,
        runId: this.runId,
      };
    },
  );

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
  readonly ensureMirroredInRunSubdir = Effect.fn(
    'RunWorkspace.ensureMirroredInRunSubdir',
  )(
    { self: this },
    function* (
      relativeDirectory: string,
      options: { readonly protectedStem?: string } = {},
    ): Effect.fn.Return<void, never, FileSystem.FileSystem> {
      if (this.mirroredDependencies.size === 0) return;

      const fs = yield* FileSystem.FileSystem;
      yield* Effect.forEach(
        [...this.mirroredDependencies],
        Effect.fnUntraced({ self: this }, function* (relativePath) {
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
          const workspaceMirrorAbsolute = this.inRunDirectory(relativePath);
          // No snapshot is the ordinary case for a read-only build asset.
          // Any other failure leaves unknown whether one exists, and
          // linking the workspace mirror then could hand an agent write at
          // `r<N>/<rel>` the user's working copy, so this dependency is
          // left unlinked, as the destination guard below does.
          const snapshot = yield* fs.stat(snapshotAbsolute).pipe(
            Effect.as('present' as const),
            Effect.catchIf(meansAbsent, () =>
              Effect.succeed('absent' as const),
            ),
            Effect.catch((error) =>
              Effect.logWarning(
                `Skipping run-dir mirror of ${relativePath}: ${toErrorMessage(error)}`,
              ).pipe(withLogChannel(CHANNEL), Effect.as('unreadable' as const)),
            ),
          );
          if (snapshot === 'unreadable') return;
          const sourceAbsolute =
            snapshot === 'present' ? snapshotAbsolute : workspaceMirrorAbsolute;
          const destinationAbsolute = this.inRunDirectory(
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
    },
  );
}

/** Each run activation's workspace, by the activation's scope. */
const workspaces = new WeakMap<Scope.Scope, RunWorkspace>();

/**
 * The workspace of the run activation `run` is, created at its first call:
 * one per launch or resume, held as long as the activation's scope is, so
 * what an earlier call prepared and mirrored is what a later call links.
 */
export function runWorkspaceOf(
  run: { readonly runId: RunId; readonly scope: Scope.Scope },
  roots: WorkspaceRootsOf,
): RunWorkspace {
  const known = workspaces.get(run.scope);
  if (known !== undefined) return known;
  const workspace = new RunWorkspace(run.runId, roots);
  workspaces.set(run.scope, workspace);
  return workspace;
}
