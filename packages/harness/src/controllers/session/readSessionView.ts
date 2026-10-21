/**
 * A session's view read cold, from its store alone, for a host that lists
 * the projects under a storage root without opening a session on each: the
 * listing replayed through the session's own input reader and folded once,
 * with the owners its unfinished runs name probed for liveness the way an
 * open session's prober does (`./ownerLiveness`).
 */
import {
  Cause,
  Context,
  Effect,
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
import { fold } from '@shared/session/sessionFold';
import type { ProcessIdentity } from '@shared/session/sessionEvents';
import { SessionInputs } from '@shared/session/sessionInputs';
import { emptySessionView } from '@shared/session/sessionView';
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

/** A store this cold read may not open because none is there: its
 *  directory is gone, or SQLite finds no file to open without creating it. */
const absent = (error: DatabaseOpenFailed): boolean =>
  cannotOpen(Cause.fail(error)) ||
  (Predicate.hasProperty(error.cause, 'code') && error.cause.code === 'ENOENT');

/**
 * The view of the session stored at `storage`, folded from its listing,
 * its probed owners' deaths folded beside it; none when no store is there.
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
    const view = fold(
      emptySessionView(storage),
      Option.getOrElse(replay, () => []),
    );
    const dead = yield* deadOwners(view, null);
    return Option.some(
      fold(view, { _tag: 'local', local: { ...NO_LOCAL_STATE, dead } }),
    );
  });
  return yield* Effect.scoped(read).pipe(
    Effect.catchIf(absent, () => Effect.succeed(Option.none<SessionView>())),
  );
});
