/**
 * A session's view read cold, from its store alone, for a host that lists
 * the projects under a storage root without opening a session on each: the
 * listing replayed through the session's own input reader and folded once,
 * with the owners its unfinished runs name probed for liveness the way an
 * open session's prober does (`./ownerLiveness`).
 */
import { join } from 'node:path';

import {
  Effect,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
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
import { SessionInputs } from '@shared/session/sessionInputs';
import { emptySessionView } from '@shared/session/sessionView';

import { SESSION_DATABASE_FILE } from './Database';
import { deadOwners } from './ownerLiveness';
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

/**
 * The view of the session stored at `storage`, folded from its listing,
 * its probed owners' deaths folded beside it; none when no store was ever
 * created there. The store is borrowed from `ProjectDatabases` for the read,
 * so a session this process has open shares its connection.
 */
export const readSessionView = Effect.fn('readSessionView')(function* (
  storage: string,
): Effect.fn.Return<
  Option.Option<SessionView>,
  DatabaseOpenFailed | PlatformError.PlatformError,
  ProcessProbe | ProjectDatabases
> {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(join(storage, SESSION_DATABASE_FILE))))
    return Option.none<SessionView>();
  const databases = yield* ProjectDatabases;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const database = yield* RcMap.get(databases, storage);
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
    }),
  );
});
