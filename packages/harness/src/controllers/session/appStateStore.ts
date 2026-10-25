/** The process's stores over its databases (`GlobalValues`, `StateStores`,
 *  the global `AppState`), read from SQLite on every operation. */
import * as path from 'node:path';

import { Effect, Layer, RcMap, Result, Schema } from 'effect';

import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import { withLogChannel } from '@logger/effectLog';
import { GlobalValues, StateStores } from '@platform/processRuntime';
import {
  AppState,
  StateReadFailed,
  StateWriteFailed,
  type AppStateStore,
} from '@platform/interfaces';
import { JsonValueSchema, type JsonValue } from '@shared/schemas';
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
import { normalizeFilePath } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { executeCommand } from '@utils/system/execUtils';

/**
 * A settings store over one family of a root's current values, captured from
 * an owned handle; the store neither opens nor closes it. `app-state` is
 * keyed by the setting key; `repo-state` by the repository root and the key,
 * so every checkout of one repository reads one value.
 */
function appStateStoreFromDatabase(
  storage: string,
  values: CurrentValues,
  scope?: { readonly repoRoot: string },
): AppStateStore {
  const family = scope === undefined ? APP_STATE : REPO_STATE;
  const rowKey = (key: string) =>
    scope === undefined ? key : JSON.stringify([scope.repoRoot, key]);
  const refused = (key: string, cause: unknown) =>
    new StateWriteFailed({
      key,
      message: `The settings store at ${storage} refused the write of "${key}": ${toErrorMessage(cause)}`,
      cause,
    });
  const encode = (
    key: string,
    value: unknown,
  ): Result.Result<JsonValue | undefined, StateWriteFailed> =>
    value === undefined
      ? Result.succeed(undefined)
      : Result.mapError(
          Schema.decodeUnknownResult(JsonValueSchema)(value),
          (cause) =>
            refused(
              key,
              new Error(`State key ${key} was given a value that is not JSON`, {
                cause,
              }),
            ),
        );
  const modify = <T, E>(
    key: string,
    change: (current: unknown) => Result.Result<T, E>,
  ): Effect.Effect<T, E | StateWriteFailed> =>
    values
      .modify(family, rowKey(key), (current) =>
        Result.flatMap(change(current), (next: T) =>
          Result.map(encode(key, next), (json) => [next, json] as const),
        ),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof DatabaseWriteFailed ? refused(key, error) : error,
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
      Effect.asVoid(modify(key, () => Result.succeed(value))),
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
    storage: string,
    workspaceRoot: string | undefined,
  ) {
    const database = yield* RcMap.get(projects, storage);
    if (workspaceRoot !== undefined) {
      yield* values
        .modify(WORKSPACE_STORES, path.basename(storage), () =>
          Result.succeed([undefined, { root: workspaceRoot }] as const),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Could not record that ${storage} serves ${workspaceRoot}; \`texra doctor --prune-storage\` will not list it as an orphan.`,
            ).pipe(
              Effect.annotateLogs({ data: error }),
              withLogChannel('sessionDatabase'),
            ),
          ),
        );
    }
    return appStateStoreFromDatabase(storage, database.values);
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
    storage: string,
    workspaceRoot: string | undefined,
  ) {
    const store = (repoRoot: string) =>
      appStateStoreFromDatabase(storage, values, {
        repoRoot: normalizeFilePath(repoRoot),
      });
    if (workspaceRoot === undefined) return store(storage);
    const result = yield* executeCommand(
      [
        'git',
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
        '--show-toplevel',
      ],
      { cwd: workspaceRoot, settings: undefined, timeout: 5_000, quiet: true },
    );
    if (!result.success) {
      if (
        !/not a git repository|must be run in a work tree/i.test(result.stderr)
      ) {
        yield* Effect.logWarning(
          `Cannot resolve the git repository of ${workspaceRoot}; its repository settings are its own. Cause: ${result.stderr}`,
        ).pipe(withLogChannel('platform'));
      }
      return store(workspaceRoot);
    }
    const [gitDirLine = '', topLevelLine = ''] = result.stdout
      .trim()
      .split(/\r?\n/);
    const worktreesDir = path.dirname(path.normalize(gitDirLine.trim()));
    const worktreesParent = path.dirname(worktreesDir);
    if (path.basename(worktreesDir) !== 'worktrees') {
      return store(path.normalize(topLevelLine.trim()));
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
export const processStoresLayer = Layer.mergeAll(
  globalValuesLayer,
  Layer.effect(
    StateStores,
    Effect.gen(function* () {
      const projects = yield* ProjectDatabases;
      const { values } = yield* GlobalDatabase;
      const spawner = yield* ChildProcessSpawner;
      return {
        project: (storage, workspaceRoot) =>
          openProjectStateStore(projects, values, storage, workspaceRoot),
        repo: (storage, workspaceRoot) =>
          openRepoStateStore(values, storage, workspaceRoot).pipe(
            Effect.provideService(ChildProcessSpawner, spawner),
          ),
      };
    }),
  ),
);

/** The process's application state, in the global root's current values at
 *  `globalStorage`: what every host keeps. */
export const globalAppStateLayer = (
  globalStorage: string,
): Layer.Layer<AppState, never, GlobalDatabase> =>
  Layer.effect(
    AppState,
    Effect.map(GlobalDatabase, (database) =>
      appStateStoreFromDatabase(globalStorage, database.values),
    ),
  );
