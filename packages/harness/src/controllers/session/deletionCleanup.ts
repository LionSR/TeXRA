/** C9 generated-file cleanup, driven only by committed deletion records. */
import * as path from 'node:path';

import {
  Data,
  Duration,
  Effect,
  FileSystem,
  type Context,
  type Fiber,
  type PlatformError,
  Schedule,
  type Scope,
} from 'effect';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { withLogChannel } from '@logger/effectLog';
import type { RunId } from '@shared/schemas';
import type { Database } from '@shared/session/database';
import { isPathWithin } from '@utils/core/pathCore';

const CHANNEL = 'DeletionCleanup';

/** The runs directory does not resolve to itself, so cleanup is refused. */
class GeneratedRootRedirected extends Data.TaggedError(
  'GeneratedRootRedirected',
)<{ readonly message: string }> {}

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
 * and the removal is no longer detected. TeXRA 1.0's file-ownership design
 * owns that remaining contract (#12139).
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

/** The wait before collecting again what a pass left pending: 30 s,
 *  doubling, at most 30 min apart. */
const RETRY_FIRST = '30 seconds';
const RETRY = Schedule.exponential(RETRY_FIRST).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.minutes(30))),
  ),
);

/** A pass that left a record pending (or could not read them). */
class DeletionPending extends Data.TaggedError('DeletionPending') {}

/**
 * The session's deletion collector, bound to the caller's scope: each run
 * of the answered effect forks one pass over the pending tombstones there,
 * answering its fiber (the session runs one at open and one after each
 * removal). Every step of a pass may run twice, in one process or two, so
 * passes never conflict. A failed record stays closed and pending, and a
 * failed read of the records is logged; either way the pass is retried on
 * {@link RETRY} until one leaves nothing pending, with one retry in flight
 * per session and none once the scope closes.
 */
export const deletionCollector = (
  database: Pick<
    Context.Service.Shape<typeof Database>,
    'readPendingDeletions' | 'collectDeletion'
  >,
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
      let pending = false;
      for (const event of yield* database.readPendingDeletions()) {
        if (event.type !== 'run.removed') continue;
        yield* database
          .collectDeletion(event, (ids) =>
            removeRunDirectories(fs, storage, ids),
          )
          .pipe(
            Effect.catch((error) => {
              pending = true;
              return Effect.logWarning(
                `Deletion cleanup remains pending for ${event.aggregateId}`,
              ).pipe(
                Effect.annotateLogs({ data: error }),
                withLogChannel(CHANNEL),
              );
            }),
          );
      }
      if (pending) return yield* new DeletionPending();
    }).pipe(
      Effect.catchTag('DatabaseReadFailed', (error) =>
        Effect.andThen(
          Effect.logWarning('Deletion records could not be read.').pipe(
            Effect.annotateLogs({ data: error }),
            withLogChannel(CHANNEL),
          ),
          new DeletionPending(),
        ),
      ),
    );
    // One retry in flight per session: a pass that leaves records pending
    // forks it, unless one is already waiting, outside the pass's fiber.
    let retrying = false;
    const collect = pass.pipe(
      Effect.catch(() => {
        if (retrying) return Effect.void;
        retrying = true;
        return pass.pipe(
          // RETRY never ends, so the retry ends only with a clean pass.
          Effect.retry(RETRY),
          Effect.delay(RETRY_FIRST),
          Effect.orDie,
          Effect.ensuring(Effect.sync(() => (retrying = false))),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      }),
    );
    return Effect.forkIn(collect, scope);
  });
