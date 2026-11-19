/** The process's stores over its databases (`GlobalValues`, `StateStores`,
 *  the global `AppState`), read from SQLite on every operation. */
import * as path from 'node:path';

import { Effect, Layer, RcMap, Result, Schema } from 'effect';

import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import { logFailure } from '@logger/effectLog';
import { GlobalValues, StateStores } from '@platform/processRuntime';
import { AppState, type AppStateStore } from '@platform/interfaces';
import { StateReadFailed, StateWriteFailed } from '@shared/config/settings';
import type { SettingsCatalog } from '@shared/state/stateSettings';
import {
  DatabaseWriteFailed,
  GlobalDatabase,
  ProjectDatabases,
  type CurrentValues,
} from '@shared/session/database';
import {
  APP_STATE,
  REPO_STATE,
  WORKSPACE_STORES,
} from '@shared/session/valueFamily';
import { normalizeFilePath } from '@utils/core/pathBasics';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { gitDirAndTopLevel } from '@utils/system/git';

/**
 * A settings store over one family of a root's current values, captured from
 * an owned handle; the store neither opens nor closes it. `app-state` is
 * keyed by `<namespace>.<key>`; `repo-state` by the repository root and that
 * key, so every checkout of one repository reads one value.
 */
function appStateStoreFromDatabase(
  storage: string,
  values: CurrentValues,
  namespace: string,
  scope?: { readonly repoRoot: string },
): AppStateStore {
  const family = scope === undefined ? APP_STATE : REPO_STATE;
  const rowKey = (key: string) =>
    scope === undefined
      ? `${namespace}.${key}`
      : JSON.stringify([scope.repoRoot, `${namespace}.${key}`]);
  const refused = (key: string, cause: unknown) =>
    new StateWriteFailed({
      key,
      message: `The settings store at ${storage} refused the write of "${key}": ${toErrorMessage(cause)}`,
      cause,
    });
  const encode = (key: string, value: unknown) =>
    value === undefined
      ? Result.succeed(undefined)
      : Result.mapError(
          Schema.decodeUnknownResult(Schema.Json)(value),
          (cause) =>
            refused(
              key,
              new Error(`State key ${key} was given a value that is not JSON`, {
                cause,
              }),
            ),
        );
  const modify = <K extends string, A, E>(
    keys: readonly K[],
    change: (
      current: Readonly<Record<K, unknown>>,
    ) => Result.Result<
      readonly [A] | readonly [A, Readonly<Record<K, unknown>>],
      E
    >,
  ): Effect.Effect<A, E | StateWriteFailed> =>
    values
      .modify(
        family,
        keys.map(rowKey),
        (
          current,
        ): Result.Result<
          readonly [A] | readonly [A, Record<string, Schema.Json | undefined>],
          E | StateWriteFailed
        > => {
          const result = change(
            // cast: one entry for each of `keys`.
            Object.fromEntries(
              keys.map((key) => [key, current[rowKey(key)]]),
            ) as Readonly<Record<K, unknown>>,
          );
          if (Result.isFailure(result)) return Result.fail(result.failure);
          if (result.success.length === 1)
            return Result.succeed([result.success[0]]);
          const [answer, next] = result.success;
          const rows: Record<string, Schema.Json | undefined> = {};
          for (const key of keys) {
            const json = encode(key, next[key]);
            if (Result.isFailure(json)) return Result.fail(json.failure);
            rows[rowKey(key)] = json.success;
          }
          return Result.succeed([answer, rows]);
        },
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof DatabaseWriteFailed
            ? refused(keys.join(', '), error)
            : error,
        ),
      );
  return {
    changes: (keys) => values.changes(family, keys.map(rowKey)),
    get: (key) =>
      values.get(family, rowKey(key)).pipe(
        Effect.mapError(
          (cause) =>
            new StateReadFailed({
              key,
              message: `The settings store at ${storage} could not read "${key}": ${toErrorMessage(cause)}`,
              cause,
            }),
        ),
      ),
    update: (key, value) =>
      modify([key], () => Result.succeed([undefined, { [key]: value }])),
    modify,
  };
}

/**
 * Retain the project's persistent database for the caller's project scope,
 * and record in the global root which workspace root the store serves
 * (`workspace-store`, keyed by the storage directory id): a storage prune
 * finds a store whose root is
 * gone by it. An unchanged record is not rewritten (`values.modify`). One
 * that cannot be read or written is logged at warn and the project still
 * opens: the prune then never lists the store as an orphan.
 */
const openProjectStateStore = Effect.fn('appStateStore.openProjectStateStore')(
  function* (
    projects: ProjectDatabases['Service'],
    values: CurrentValues,
    namespace: string,
    storage: string,
    workspaceRoot: string | undefined,
  ) {
    const database = yield* RcMap.get(projects, storage);
    if (workspaceRoot !== undefined) {
      const id = path.basename(storage);
      yield* values
        .modify(WORKSPACE_STORES, [id], () =>
          Result.succeed([
            undefined,
            { [id]: { root: workspaceRoot } },
          ] as const),
        )
        .pipe(
          Effect.catch(
            logFailure(
              'sessionDatabase',
              `Could not record that ${storage} serves ${workspaceRoot}; a storage prune will not know that store's project, so it will not offer to delete the store once that folder is gone.`,
            ),
          ),
        );
    }
    return appStateStoreFromDatabase(storage, database.values, namespace);
  },
);

/**
 * The repository settings of `workspaceRoot` (the `repoState` slot), keyed by
 * the repository every checkout shares: a linked worktree (git dir
 * `<dir>/worktrees/<name>`) by the checkout holding `<dir>` when that is
 * `.git`, else by `<dir>` (a bare repository, a submodule's `.git/modules/…`);
 * any other checkout by its own top level, so two submodules never share a
 * key; a folder outside a repository by itself; no folder by the storage
 * root. A git failure other than "not a repository" is logged at warn and the
 * folder keys by itself, so host startup never aborts on it.
 */
const openRepoStateStore = Effect.fn('appStateStore.openRepoStateStore')(
  function* (
    values: CurrentValues,
    namespace: string,
    storage: string,
    workspaceRoot: string | undefined,
  ) {
    const store = (repoRoot: string) =>
      appStateStoreFromDatabase(storage, values, namespace, {
        repoRoot: normalizeFilePath(repoRoot),
      });
    if (workspaceRoot === undefined) return store(storage);
    const dirs = yield* gitDirAndTopLevel(workspaceRoot);
    if (dirs === null) return store(workspaceRoot);
    const worktreesDir = path.dirname(path.normalize(dirs.gitDir));
    const worktreesParent = path.dirname(worktreesDir);
    if (path.basename(worktreesDir) !== 'worktrees') {
      return store(path.normalize(dirs.topLevel));
    }
    return store(
      path.basename(worktreesParent) === '.git'
        ? path.dirname(worktreesParent)
        : worktreesParent,
    );
  },
);

/** `GlobalValues` over the process's global database. */
const globalValuesLayer = Layer.effect(
  GlobalValues,
  Effect.map(GlobalDatabase, (database) => database.values),
);

/** `GlobalValues` and `StateStores`, over the process's databases. */
export const processStoresLayer = ({
  namespace,
}: SettingsCatalog): Layer.Layer<
  GlobalValues | StateStores,
  never,
  GlobalDatabase | ProjectDatabases | ChildProcessSpawner
> =>
  Layer.mergeAll(
    globalValuesLayer,
    Layer.effect(
      StateStores,
      Effect.gen(function* () {
        const projects = yield* ProjectDatabases;
        const { values } = yield* GlobalDatabase;
        const spawner = yield* ChildProcessSpawner;
        return {
          project: (storage, root) =>
            openProjectStateStore(projects, values, namespace, storage, root),
          repo: (storage, root) =>
            openRepoStateStore(values, namespace, storage, root).pipe(
              Effect.provideService(ChildProcessSpawner, spawner),
            ),
        };
      }),
    ),
  );

/** The process's application state, in the global root's current values at
 *  `globalStorage` under the catalog's namespace: what every host keeps. */
export const globalAppStateLayer = (
  globalStorage: string,
  { namespace }: SettingsCatalog,
): Layer.Layer<AppState, never, GlobalDatabase> =>
  Layer.effect(
    AppState,
    Effect.map(GlobalDatabase, (database) =>
      appStateStoreFromDatabase(globalStorage, database.values, namespace),
    ),
  );
