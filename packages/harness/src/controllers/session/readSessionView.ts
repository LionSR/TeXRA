/**
 * A session's view read cold, from its store alone, for a host that lists
 * the projects under a storage root without opening a session on each: the
 * listing replayed through the session's own input reader and applied once,
 * with the owners its unfinished runs name probed for liveness the way an
 * open session's prober does (`./ownerLiveness`).
 */
import {
  Cause,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  RcMap,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { ProcessProbe } from '@platform/defaults/nodeProcesses';
import type { LocalRuntimeState } from '@shared/schemas';
import {
  Database,
  type DatabaseOpenFailed,
  ProjectDatabases,
} from '@shared/session/database';
import type { SessionView } from '@shared/session/readonlyViews';
import type { ProcessIdentity } from '@shared/session/sessionEvents';
import { SessionInputs } from '@shared/session/sessionInputs';
import { makeSessionViewUpdater } from '@shared/session/sessionViewUpdate';
import type { ToolRegistry } from '@tools/toolTable';

import { databaseLayer } from './Database';
import { deadOwners } from './ownerLiveness';
import { cannotOpen } from './storeAside';
import { sessionInputsLayer } from './sessionInputs';
import { LocalRuntimeSource, TextChunkSource } from './sessionSources';
import { WorkspaceRoots } from './WorkspaceRoots';

/** No owner of this process: a cold read holds no run. */
const NO_LOCAL_STATE: LocalRuntimeState = {
  self: [],
  dead: [],
  unreadable: [],
  resumeBlocked: [],
};

/** Whether this cold read failed because no store is there: its directory
 *  is gone, or SQLite could not open a file that does not exist. SQLite's
 *  CANTOPEN also names a store it may not open (permissions, a bad path),
 *  which stays the read's failure. */
const absent = (
  error: DatabaseOpenFailed,
): Effect.Effect<boolean, never, FileSystem.FileSystem> => {
  if (
    Predicate.hasProperty(error.cause, 'code') &&
    error.cause.code === 'ENOENT'
  )
    return Effect.succeed(true);
  if (!cannotOpen(Cause.fail(error))) return Effect.succeed(false);
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(error.path)),
    Effect.map((exists) => !exists),
    // Unknown: the open's own failure stands.
    Effect.catch((cause) =>
      Effect.logWarning(`Could not check whether ${error.path} exists`).pipe(
        Effect.annotateLogs({ data: cause }),
        Effect.as(false),
      ),
    ),
  );
};

/**
 * The view of the session stored at `storage`, built from its listing, with
 * its probed owners' deaths applied beside it; none when no store is there.
 * A connection this process already holds (`ProjectDatabases`) is shared;
 * otherwise the read opens the store for itself without ever creating one,
 * so a store a prune just removed is read as gone, never made again.
 */
export const readSessionView = Effect.fn('readSessionView')(function* (
  storage: string,
): Effect.fn.Return<
  Option.Option<SessionView>,
  DatabaseOpenFailed,
  ProcessProbe | ProjectDatabases | ProcessIdentity | ToolRegistry
> {
  const databases = yield* ProjectDatabases;
  const read = Effect.gen(function* () {
    const held = yield* RcMap.getOption(databases, storage);
    const database = Option.isSome(held)
      ? held.value
      : Context.get(
          yield* Layer.build(
            databaseLayer('existing').pipe(
              Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
            ),
          ),
          Database,
        );
    const local = yield* SubscriptionRef.make(NO_LOCAL_STATE);
    const inputs = yield* SessionInputs.pipe(
      Effect.provide(
        sessionInputsLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Database)(database),
              Layer.succeed(LocalRuntimeSource)({ ref: local }),
              TextChunkSource.layer,
              Layer.succeed(WorkspaceRoots)({ storage }),
            ),
          ),
        ),
      ),
    );
    const replay = yield* Stream.runHead(inputs.read([], 0, false));
    const updater = makeSessionViewUpdater(storage);
    const view = updater.apply(Option.getOrElse(replay, () => []));
    const dead = yield* deadOwners(view, null);
    return Option.some(
      updater.apply({ _tag: 'local', local: { ...NO_LOCAL_STATE, dead } }),
    );
  });
  return yield* Effect.scoped(read).pipe(
    Effect.catch((error) =>
      Effect.flatMap(absent(error), (gone) =>
        gone ? Effect.succeed(Option.none<SessionView>()) : Effect.fail(error),
      ),
    ),
  );
});
