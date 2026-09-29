/** Settings stores over a root's current values, read from SQLite on every operation. */
import * as path from 'node:path';

import { Effect, RcMap, Result } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
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
import { normalizeFilePath } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { executeCommand } from '@utils/system/execUtils';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/**
 * A settings store over one family of a root's current values, captured from
 * an owned handle; the store neither opens nor closes it. `app-state` is
 * keyed by the setting key; `repo-state` by the repository root and the key,
 * so every checkout of one repository reads one value.
 */
export function appStateStoreFromDatabase(
  storage: string,
  values: CurrentValues,
  scope?: { readonly family: 'repo-state'; readonly repoRoot: string },
): AppStateStore {
  const family = scope?.family ?? 'app-state';
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
      : Result.try({
          try: () => JsonValueSchema.parse(value),
          catch: (cause) =>
            refused(
              key,
              new Error(`State key ${key} was given a value that is not JSON`, {
                cause,
              }),
            ),
        });
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

/** Retain the project's persistent database for the caller's project scope. */
export const openProjectStateStore = Effect.fn(
  'appStateStore.openProjectStateStore',
)(function* (storage: string) {
  const database = yield* RcMap.get(yield* ProjectDatabases, storage);
  return appStateStoreFromDatabase(storage, database.values);
});

/**
 * The repository settings of `workspaceRoot` (the catalog's `repoState`
 * slot), in the global root's current values, keyed by the repository every
 * checkout of it shares.
 *
 * A linked worktree, whose git dir is `<dir>/worktrees/<name>`, keys by the
 * checkout holding `<dir>` when `<dir>` is `.git` (a plain repository's main
 * worktree) and by `<dir>` itself otherwise (a bare repository, or a
 * submodule's `.git/modules/…`). Every other checkout (a main worktree, a
 * submodule) keys by its own top level, so two submodules never share one
 * key. A folder outside any repository keys by itself, and no folder at all
 * by the project's storage root. "Not a git repository" and "must be run in
 * a work tree" are expected answers; any other failure (git missing, a
 * timeout) is logged at warn and the folder keys by itself, so host startup
 * is never aborted by it.
 */
export const openRepoStateStore = Effect.fn('appStateStore.openRepoStateStore')(
  function* (
    workspaceRoot: string | undefined,
    storage: string,
  ): Effect.fn.Return<
    AppStateStore,
    never,
    GlobalDatabase | ChildProcessSpawner
  > {
    const { values } = yield* GlobalDatabase;
    const store = (repoRoot: string) =>
      appStateStoreFromDatabase(storage, values, {
        family: 'repo-state',
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
