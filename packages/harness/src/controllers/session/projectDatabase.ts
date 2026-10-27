/** One persistent connection per project root, shared by its scoped
 *  borrowers, and storage maintenance over the project stores under a
 *  storage root. */
import * as path from 'node:path';

import { Context, Effect, FileSystem, Layer, RcMap } from 'effect';

import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import { GlobalValues } from '@platform/processRuntime';
import { Database, ProjectDatabases } from '@shared/session/database';
import { WORKSPACE_STORES } from '@shared/session/valueFamily';

import { databaseLayer, storeOpenElsewhere } from './Database';
import { asideCopies } from './storeAside';
import { WorkspaceRoots } from './WorkspaceRoots';

/** No idle retention or explicit invalidation: the project owns its state
 *  borrow and the session graph owns its borrow until their scopes unwind. */
export const projectDatabaseLayer = Layer.effect(
  ProjectDatabases,
  RcMap.make({
    lookup: (storage: string) =>
      Layer.build(
        databaseLayer('persistent').pipe(
          Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
        ),
      ).pipe(Effect.map((context) => Context.get(context, Database))),
  }),
);

/**
 * What storage maintenance found under a storage root: the workspace stores whose `workspace-store` record names a root that
 * is gone, and the `.pre1`/`.corrupt-` aside copies beside the stores that
 * remain. The store of no workspace has no root and is never an orphan.
 * Nothing goes without the caller's word: an unmounted
 * drive looks exactly like a deleted root.
 */
export interface StorageInventory {
  readonly orphans: readonly {
    readonly directory: string;
    readonly bytes: number;
    readonly why: string;
  }[];
  readonly asides: readonly { readonly path: string; readonly bytes: number }[];
  /** The directories that could not be read, and why. */
  readonly skipped: readonly {
    readonly path: string;
    readonly message: string;
  }[];
}

/** The orphaned stores and aside copies under `storageRoot`. */
export const readStorageInventory = Effect.fn('readStorageInventory')(
  function* (storageRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const records = new Map(
      (yield* (yield* GlobalValues).list(WORKSPACE_STORES)).map(
        (row) => [row.key, row.value] as const,
      ),
    );
    const none = resolveWorkspaceStoragePath(storageRoot, undefined);
    const global = resolveGlobalStoragePath(storageRoot);
    const ids = (yield* fs.exists(path.dirname(none)))
      ? yield* fs.readDirectory(path.dirname(none))
      : [];
    const orphans: StorageInventory['orphans'][number][] = [];
    const asides: StorageInventory['asides'][number][] = [];
    const skipped: StorageInventory['skipped'][number][] = [];
    for (const directory of [
      ...((yield* fs.exists(global)) ? [global] : []),
      ...ids.toSorted().map((id) => path.join(path.dirname(none), id)),
    ]) {
      yield* Effect.gen(function* () {
        if ((yield* fs.stat(directory)).type !== 'Directory') return;
        const id = path.basename(directory);
        const record =
          directory === global || id === path.basename(none)
            ? undefined
            : records.get(id);
        const database = path.join(directory, 'texra.db');
        if (record === undefined || (yield* fs.exists(record.root))) {
          asides.push(...(yield* asideCopies(database)));
          return;
        }
        const sizes = yield* Effect.forEach(
          yield* fs.readDirectory(directory, { recursive: true }),
          (name) =>
            Effect.map(fs.stat(path.join(directory, name)), (info) =>
              info.type === 'File' ? Number(info.size) : 0,
            ),
          { concurrency: 8 },
        );
        const bytes = sizes.reduce((sum, size) => sum + size, 0);
        // A store whose database is not SQLite is still an orphan.
        const unreadable =
          (yield* fs.exists(database)) &&
          (yield* storeOpenElsewhere(database)) === 'unreadable';
        const why = `${record.root} no longer exists`;
        orphans.push({
          directory,
          bytes,
          why: unreadable ? `${why}; unreadable (not a SQLite store)` : why,
        });
      }).pipe(
        Effect.catch((error: Error) =>
          Effect.sync(() => {
            skipped.push({ path: directory, message: error.message });
          }),
        ),
      );
    }
    return { orphans, asides, skipped } satisfies StorageInventory;
  },
);

/**
 * Delete what an inventory of `storageRoot` listed, each item on its own.
 * Only an item a fresh read of the inventory still lists is touched: a path
 * that is no longer an orphan or an aside copy under `storageRoot` (its root
 * came back, a drive was remounted, or it was never listed there) is
 * reported and left in place. An orphan store another process has open is
 * kept, and a failed deletion is reported while the rest still go. Each
 * item's outcome, in listing order.
 */
export const deleteStorageInventory = Effect.fn('deleteStorageInventory')(
  function* (
    storageRoot: string,
    inventory: Pick<StorageInventory, 'orphans' | 'asides'>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const fresh = yield* readStorageInventory(storageRoot);
    const listed = new Set([
      ...fresh.orphans.map(({ directory }) => directory),
      ...fresh.asides.map(({ path: aside }) => aside),
    ]);
    const remove = (target: string, store: boolean) =>
      Effect.gen(function* () {
        if (!listed.has(target))
          return {
            path: target,
            outcome: 'failed' as const,
            message: `no longer listed in the inventory of ${storageRoot}; left in place`,
          };
        const database = path.join(target, 'texra.db');
        if (
          store &&
          (yield* fs.exists(database)) &&
          (yield* storeOpenElsewhere(database)) === 'open'
        )
          return { path: target, outcome: 'kept' as const };
        yield* fs.remove(target, { recursive: store, force: !store });
        return { path: target, outcome: 'deleted' as const };
      }).pipe(
        Effect.catch((error: Error) =>
          Effect.succeed({
            path: target,
            outcome: 'failed' as const,
            message: error.message,
          }),
        ),
      );
    return yield* Effect.forEach(
      [
        ...inventory.orphans.map(({ directory }) => remove(directory, true)),
        ...inventory.asides.map(({ path: aside }) => remove(aside, false)),
      ],
      (removal) => removal,
      { concurrency: 8 },
    );
  },
);
