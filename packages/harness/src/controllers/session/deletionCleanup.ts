/**
 * A run's removal: a `run.delete`, which removes the run from its log; the
 * removal of the files a run generated, driven only by committed deletion
 * records; and the `run.files` request that copies a stopped run's
 * directory into the workspace or removes it.
 */
import * as path from 'node:path';

import {
  type Context,
  Effect,
  type Fiber,
  FileSystem,
  Path,
  type PlatformError,
  Schema,
  type Scope,
} from 'effect';

import { runNoun } from '@agent/runtime/forkRun';
import { RunLive } from '@agent/runtime/runRegistry';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { withLogChannel } from '@logger/effectLog';
import {
  SessionRoots,
  StorageFs,
  WorkspaceFs,
  withSessionFs,
} from '@platform/rootedFs';
import { qualifyAggregateId, type RunId } from '@shared/schemas';
import {
  DatabaseClaimRefused,
  type AggregateState,
  type Database,
  type DeletionMode,
} from '@shared/session/database';
import { recordOf } from '@shared/session/runRowReads';
import {
  NotOwner,
  Rejected,
  Unavailable,
  type RequestError,
  type OutcomeOf,
  type RunFilesResult,
  type RuntimeRequest,
} from '@shared/session/runtimeRequest';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import { SessionLog, type SessionViewAccess } from '@shared/session/runHistory';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { copyDereferenced } from '@utils/files/fsDurability';
import { absentReason } from '@utils/files/fsEntryExists';
import { isPathWithin } from '@utils/core/pathCore';

const CHANNEL = 'DeletionCleanup';

/** The runs directory does not resolve to itself, so cleanup is refused. */
class GeneratedRootRedirected extends Schema.TaggedError<GeneratedRootRedirected>()(
  'GeneratedRootRedirected',
  {
    message: Schema.String,
  },
) {}

/**
 * Remove each run's run directory under the storage root it was
 * admitted against.
 *
 * Both the storage root and its runs directory are resolved with `realPath`,
 * and the runs directory must resolve to itself: a root that was replaced by
 * a link to somewhere else is refused rather than followed, so a swapped
 * storage directory can never redirect deletion outside admitted storage.
 * Each target is then checked to fall inside the resolved runs directory.
 *
 * A refusal fails with `GeneratedRootRedirected`, which leaves the deletion
 * record closed and pending instead of collected, so the same deletion marker
 * retries once the root is sane.
 *
 * This is resolve-then-check, not the handle-confined deletion the retired
 * native addon performed: a root replaced in the window *between* the resolve
 * and the removal is no longer detected.
 */
const removeRunDirectories = (
  fs: FileSystem.FileSystem,
  storage: string,
  runIds: readonly RunId[],
): Effect.Effect<void, PlatformError.PlatformError | GeneratedRootRedirected> =>
  Effect.gen(function* () {
    const runs = path.join(
      yield* fs.realPath(storage),
      WORKSPACE_STORAGE_LAYOUT.runs,
    );
    // Fails NotFound when the runs directory is absent, which the catch
    // below reads as "nothing generated to remove".
    if ((yield* fs.realPath(runs)) !== runs) {
      return yield* new GeneratedRootRedirected({
        message: `Refusing generated-file cleanup: ${runs} does not resolve to itself`,
      });
    }
    yield* Effect.forEach(
      runIds,
      (runId) => {
        const target = path.join(runs, runId);
        if (!isPathWithin(runs, target)) {
          return Effect.logWarning(
            `Refusing to remove ${target}: outside the admitted storage root`,
          ).pipe(withLogChannel(CHANNEL));
        }
        return fs.remove(target, { recursive: true, force: true });
      },
      { concurrency: 8, discard: true },
    );
  }).pipe(
    Effect.uninterruptible,
    Effect.catchIf(absentReason, () => Effect.void),
  );

/**
 * The session's deletion collector, bound to the caller's scope: each run
 * of the answered effect forks one pass over the pending deletion markers there,
 * answering its fiber (the session runs one at open and one after each
 * removal). Every step of a pass may run twice, in one process or two, so
 * passes never conflict; a failed record stays closed and pending for the
 * next pass, and a failed read of the records is logged.
 */
export const deletionCollector = Effect.fn('deletionCleanup.deletionCollector')(
  function* (
    database: Pick<Context.Service.Shape<typeof Database>, 'deletions'>,
    storage: string,
  ): Effect.fn.Return<
    Effect.Effect<Fiber.Fiber<void>>,
    never,
    FileSystem.FileSystem | Scope.Scope
  > {
    const fs = yield* FileSystem.FileSystem;
    const scope = yield* Effect.scope;
    const pass = Effect.gen(function* () {
      for (const event of yield* database.deletions.pending()) {
        const marker = recordOf(event).removed;
        if (marker === null) continue;
        yield* database.deletions
          .collect(marker, (ids) => removeRunDirectories(fs, storage, ids))
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Deletion cleanup remains pending for ${marker.aggregateId}`,
              ).pipe(
                Effect.annotateLogs({ data: error }),
                withLogChannel(CHANNEL),
              ),
            ),
          );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning('Deletion records could not be read.').pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel(CHANNEL),
        ),
      ),
    );
    return Effect.forkIn(pass, scope);
  },
);

/** What a `run.files` request reads from the process: its files. */
export type RunFilesServices = FileSystem.FileSystem | Path.Path;

/**
 * Copy a stopped run's directory to the workspace path `to`, or remove it;
 * `false` when the run has no directory. Symlinks are dereferenced so a copy
 * stands alone, and a copy onto an existing folder fails rather than merging
 * into it.
 */
const copyOrRemoveRunDir = Effect.fn('runStorage.copyOrRemoveRunDir')(
  function* (
    runId: RunId,
    files:
      { readonly op: 'copy'; readonly to: string } | { readonly op: 'remove' },
  ) {
    const storageFs = yield* StorageFs;
    const runDir = path.posix.join(WORKSPACE_STORAGE_LAYOUT.runs, runId);
    if (!(yield* storageFs.exists(runDir))) {
      yield* Effect.logWarning(`Run directory not found for run ${runId}`);
      return false;
    }
    if (files.op === 'remove') {
      yield* Effect.logInfo(`Removing the run directory ${runDir}`);
      yield* storageFs.remove(runDir, { recursive: true, force: true });
      return true;
    }
    const workspaceFs = yield* WorkspaceFs;
    const source = yield* storageFs.resolve(runDir);
    const destination = yield* workspaceFs.resolve(files.to);
    yield* workspaceFs.makeDirectory((yield* Path.Path).dirname(files.to), {
      recursive: true,
    });
    yield* copyDereferenced(source, destination);
    yield* Effect.logInfo(`Copied ${source} -> ${destination}`);
    return true;
  },
);

/** The registry's step on an inactive run, which refuses one anything
 *  still runs and holds a launch back until it ends. */
interface InactiveRunStep {
  readonly withInactiveRunStep: <A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | Error, R>;
}

/** A `run.delete`, or a listing's removal: the admitted lifetime's rows
 *  removed from the log once the registry's inactive run step holds the
 *  run, which refuses one anything still runs. */
export const deleteAdmittedRun = (
  deps: {
    readonly log: Pick<SessionEventsShape, 'removeRun'>;
    readonly view: SessionViewAccess['Service'];
  },
  runId: RunId,
  admitted: AggregateState,
  mode: DeletionMode,
  runs: InactiveRunStep,
): Effect.Effect<OutcomeOf<'run.delete'>, RequestError> => {
  const aggregateId = qualifyAggregateId('run', runId);
  return Effect.gen(function* () {
    if (admitted.startCommit === null) {
      return yield* new Unavailable({
        runId,
        reason: `The ${runNoun(deps.view, runId)} has no recorded start.`,
      });
    }
    yield* runs
      .withInactiveRunStep(
        runId,
        deps.log.removeRun(aggregateId, mode, admitted.startCommit),
      )
      .pipe(
        Effect.mapError((error): RequestError => {
          if (error instanceof RunLive)
            return new Unavailable({
              runId,
              reason: `Stop the ${runNoun(deps.view, runId)} before deleting it.`,
            });
          if (error instanceof DatabaseClaimRefused) {
            return error.verdict === 'alive'
              ? new NotOwner({ runId })
              : new Rejected({
                  reason:
                    'The current owner could not be verified, so automatic or bulk deletion was refused.',
                });
          }
          return new Unavailable({
            runId,
            reason: `The ${runNoun(deps.view, runId)} could not be removed from the listing.`,
          });
        }),
      );
    return { kind: 'done' } as const;
  });
};

/**
 * Answer a `run.files` request on its session as one step on the inactive run
 * (`runs`: the registry's `withInactiveRunStep`), its claim taken for the
 * operation: a run launched here or held by another live process refuses
 * it, a launch arriving meanwhile waits for it, and the claim is never taken
 * on another process's behalf. What a copy is for, and where it goes, is the
 * requesting app's.
 */
export const runFiles = Effect.fn('runFiles')(function* (
  runs: InactiveRunStep,
  req: Extract<RuntimeRequest, { kind: 'run.files' }>,
): Effect.fn.Return<
  OutcomeOf<'run.files'>,
  RequestError,
  RunFilesServices | SessionLog | SessionRoots
> {
  const roots = yield* SessionRoots;
  const log = yield* SessionLog;
  return yield* runs
    .withInactiveRunStep(
      req.runId,
      log.hold(req.runId).pipe(
        Effect.andThen(
          copyOrRemoveRunDir(req.runId, req.files).pipe(
            Effect.map((found): RunFilesResult => {
              if (!found) return { status: 'noFiles' };
              return req.files.op === 'copy'
                ? { status: 'done', to: req.files.to }
                : { status: 'done' };
            }),
            Effect.catch((error) =>
              Effect.logError(
                `The ${req.files.op} of run ${req.runId} failed`,
              ).pipe(
                Effect.annotateLogs({ data: error }),
                Effect.as<RunFilesResult>({
                  status: 'error',
                  error: toErrorMessage(error),
                }),
              ),
            ),
          ),
        ),
        Effect.scoped,
      ),
    )
    .pipe(
      Effect.mapError((cause) =>
        cause instanceof Rejected
          ? cause
          : new Rejected({
              reason: `This run is running or held elsewhere: ${toErrorMessage(cause)}`,
            }),
      ),
      Effect.map((result) => ({ kind: 'runFiles', result }) as const),
      (program) => withSessionFs(roots, program),
      withLogChannel('runFiles'),
    );
});
