/**
 * A run's directory on disk: removing the files a run generated, driven
 * only by committed deletion records, and the `run.files` request that
 * copies a stopped run's directory into the workspace or removes it.
 */
import * as path from 'node:path';

import {
  type Context,
  Effect,
  type Fiber,
  FileSystem,
  type Path,
  type PlatformError,
  Schema,
  type Scope,
} from 'effect';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { withLogChannel } from '@logger/effectLog';
import { withSessionFs } from '@platform/rootedFs';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { RunId } from '@shared/schemas';
import type { Database } from '@shared/session/database';
import { Rejected, type RequestError } from '@shared/session/runtimeRequest';
import type {
  Outcome,
  RunFilesResult,
  RuntimeRequest,
} from '@shared/session/runtimeRequest';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { copyOrRemoveRunDir } from '@utils/files/runStorageFs';
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
 * record closed and pending instead of collected, so the same tombstone
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
      { discard: true },
    );
  }).pipe(
    Effect.uninterruptible,
    Effect.catchIf(
      (error) =>
        error._tag === 'PlatformError' && error.reason._tag === 'NotFound',
      () => Effect.void,
    ),
  );

/**
 * The session's deletion collector, bound to the caller's scope: each run
 * of the answered effect forks one pass over the pending tombstones there,
 * answering its fiber (the session runs one at open and one after each
 * removal). Every step of a pass may run twice, in one process or two, so
 * passes never conflict; a failed record stays closed and pending for the
 * next pass, and a failed read of the records is logged.
 */
export const deletionCollector = (
  database: Pick<Context.Service.Shape<typeof Database>, 'deletions'>,
  storage: string,
): Effect.Effect<
  Effect.Effect<Fiber.Fiber<void>>,
  never,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scope = yield* Effect.scope;
    const pass = Effect.gen(function* () {
      for (const event of yield* database.deletions.pending()) {
        if (event.type !== 'run.removed') continue;
        yield* database.deletions
          .collect(event, (ids) => removeRunDirectories(fs, storage, ids))
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Deletion cleanup remains pending for ${event.aggregateId}`,
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
  });

/** What a `run.files` request reads from the process: its files. */
export type RunFilesServices = FileSystem.FileSystem | Path.Path;

/**
 * Answer a `run.files` request on `session` with the run held for the
 * operation (`runs.launch({ hold })`): that takes its claim and refuses a run
 * live here, so a resume never starts under it, and the claim is never taken
 * on another process's behalf. What a copy is for, and where it goes, is the
 * requesting app's.
 */
export const runFiles = (
  session: {
    readonly roots: WorkspaceRoots;
    readonly runs: {
      readonly launch: (spec: {
        readonly hold: RunId;
      }) => Effect.Effect<void, Error, Scope.Scope>;
    };
  },
  req: Extract<RuntimeRequest, { kind: 'run.files' }>,
): Effect.Effect<Outcome, RequestError, RunFilesServices> =>
  session.runs.launch({ hold: req.runId }).pipe(
    Effect.mapError((cause) =>
      cause instanceof Rejected
        ? cause
        : new Rejected({
            reason: `This run is running or held elsewhere: ${toErrorMessage(cause)}`,
          }),
    ),
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
    Effect.map((result): Outcome => ({ kind: 'runFiles', result })),
    Effect.scoped,
    (program) => withSessionFs(session.roots, program),
    withLogChannel('runFiles'),
  );
