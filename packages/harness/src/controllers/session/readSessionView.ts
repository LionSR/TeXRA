/**
 * A session's view read cold, from its store alone, for a host that lists
 * the projects under a storage root without opening a session on each: the
 * listing replayed as a session's input reader replays it, applied once.
 * A store another process holds exclusively does not open: the read fails
 * with the holder's refusal (`STORE_HELD_MESSAGE`).
 */
import {
  Cause,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  RcMap,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import type { LocalRuntimeState } from '@shared/schemas';
import {
  Database,
  type DatabaseOpenFailed,
  ProjectDatabases,
} from '@shared/session/database';
import type { SessionView } from '@shared/session/readonlyViews';
import { makeSessionViewUpdater } from '@shared/session/sessionViewUpdate';
import type { ToolRegistry } from '@tools/toolTable';
import { absentReason } from '@utils/files/fsEntryExists';

import { databaseLayer } from './databaseLayer';
import { projectStores } from './projectDatabase';
import { cannotOpen } from './storeAside';
import { readReplay } from './sessionInputsLayer';
import { WorkspaceRoots } from './WorkspaceRoots';

/** A cold read holds no run. */
const NO_LOCAL_STATE: LocalRuntimeState = { runsHere: [] };

/** Whether this cold read failed because no store is there: its directory
 *  is gone, or SQLite could not open a file that does not exist. SQLite's
 *  CANTOPEN also names a store it may not open (permissions, a bad path),
 *  which stays the read's failure. */
const absent = (
  error: DatabaseOpenFailed,
): Effect.Effect<boolean, never, FileSystem.FileSystem> => {
  if (absentReason(error.cause)) return Effect.succeed(true);
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
 * The view of the session stored at `storage`, built from its listing;
 * none when no store is there.
 * A connection this process already holds (`ProjectDatabases`) is shared;
 * otherwise the read opens the store for itself without ever creating one,
 * so a store a prune just removed is read as gone, never made again.
 */
export const readSessionView = Effect.fn('readSessionView')(function* (
  storage: string,
): Effect.fn.Return<
  Option.Option<SessionView>,
  DatabaseOpenFailed,
  FileSystem.FileSystem | ChildProcessSpawner | ProjectDatabases | ToolRegistry
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
    const replay = yield* readReplay(database, {
      debug: false,
      local: NO_LOCAL_STATE,
      subscriptions: [],
      // A failed read fails the cold read; `projectViews` says so.
      at: yield* Effect.orDie(database.currentCommit),
    });
    const updater = makeSessionViewUpdater(storage);
    return Option.some(updater.apply(replay));
  });
  return yield* Effect.scoped(read).pipe(
    Effect.catch((error) =>
      Effect.flatMap(absent(error), (gone) =>
        gone ? Effect.succeed(Option.none<SessionView>()) : Effect.fail(error),
      ),
    ),
  );
});

/** One project under a storage root, as `Sessions.projects` lists it. */
export interface ProjectView {
  /** The project's folder. */
  readonly workspace: string;
  /** Its storage directory. */
  readonly storage: string;
  readonly view: SessionView;
}

/**
 * Every project under `storageRoot` (`projectStores`): a session this
 * process holds answers from its live view (`held`, by storage directory),
 * any other is read cold from its store. A store that cannot be opened or
 * replayed (a defect included) is logged and left out, so one damaged store
 * never hides the rest.
 */
export const projectViews = Effect.fn('projectViews')(function* (
  storageRoot: string,
  held: (storage: string) => SessionView | undefined,
) {
  const views: ProjectView[] = [];
  for (const { workspace, storage } of yield* projectStores(storageRoot)) {
    const live = held(storage);
    if (live !== undefined) {
      views.push({ workspace, storage, view: live });
      continue;
    }
    const cold = yield* readSessionView(storage).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Leaving ${workspace} out of the project list: its store could not be read`,
          cause,
        ).pipe(Effect.as(Option.none<SessionView>())),
      ),
    );
    if (Option.isSome(cold))
      views.push({ workspace, storage, view: cold.value });
  }
  return views;
});
