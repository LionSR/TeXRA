/**
 * The JSON stores a Node-family host (CLI, desktop, extension) opens while
 * it composes its process.
 *
 * Every host resolves the same files from the same storage root, so the
 * derivations live here once: which stores back workspace and local
 * configuration (the project `.texra/config.json`, the internal workspace
 * store), where global configuration lives. Workspace and global state are
 * not here: they are rows in the root's database
 * (`@controllers/session/appStateStore`), not files.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, Result, Schema } from 'effect';

// Local imports
import {
  JsonStore,
  projectValueIgnored,
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
  type JsonConfigProviderOptions,
} from '@texra-ai/worldline/node';
import {
  type SettingsCatalog,
  toErrorMessage,
} from '@texra-ai/worldline/schemas';

import {
  TEXRA_CONFIG_FILE_NAME,
  workspaceTexraConfigPath,
} from './nodeStorage';

/**
 * Name the entries of a config file that cannot apply. An unknown key (a
 * typo such as `texra.modle`) is a setting that silently never applies, and
 * so is a known key whose value its catalog row rejects: a typed read gets
 * its row's default, and a fail-closed reader its own reading (telemetry
 * reads as off). Unknown keys are named for the project file only: the
 * internal and user files are shared by every TeXRA build on the machine,
 * and may hold rows this one does not declare.
 */
function configFileWarnings(
  catalog: SettingsCatalog,
  store: JsonStore,
  isProjectFile: boolean,
): string[] {
  return store.keys().flatMap((key) => {
    const row = catalog.byStoredKey(key);
    if (row?.slot !== 'config') {
      return isProjectFile
        ? [`Ignoring unknown ${store.filePath} key "${key}".`]
        : [];
    }
    const value = store.get(key);
    return Result.isFailure(Schema.decodeUnknownResult(row.schema)(value))
      ? [
          `Ignoring invalid ${store.filePath} value ${JSON.stringify(value)} for "${key}".`,
        ]
      : [];
  });
}

/**
 * Open the stores backing the workspace and local config targets. The desktop
 * opens one pair per project beside the process-wide global store;
 * single-workspace hosts go through {@link openTexraConfigStores}.
 *
 * One home per target, fixed by one rule: a workspace's project configuration
 * is its `.texra/config.json`, the committable file all three hosts share;
 * only a session without a workspace uses the internal workspace store. The
 * local store is always the internal one, `config.json` in the workspace's
 * storage directory: this user's own settings for the workspace, which the
 * project cannot supply. The home is never chosen by writability, so no value
 * can be stranded in a store another open did not pick. A read-only project
 * reads its file and fails loudly at the first write. A file that cannot be
 * read (missing permissions, malformed JSON) is reported in `warnings` and
 * serves as an empty, effectively read-only view: every write re-reads the
 * file and fails rather than overwriting it.
 *
 * A project file that sets a row the catalog scopes to the user (the approval
 * settings) is ignored, and `warnings` names each such key: a cloned repository
 * must not loosen approvals, and the person must not find out by surprise.
 * A project opt-out of telemetry is honoured, not ignored, so it is not warned.
 * The file is left as it is, so the warning repeats until the key is removed.
 * `warnings` also names each entry of either store that cannot apply (an
 * unknown project key, a value its row rejects).
 *
 * No write runner is supplied: a config store is written through the store's
 * own Effect `set`, which composes into the writer's program.
 */
export const openTexraWorkspaceConfigStores = Effect.fn(
  'nodeStores.openTexraWorkspaceConfigStores',
)(function* (
  catalog: SettingsCatalog,
  storageRoot: string,
  workspaceRoot: string | undefined,
) {
  const warnings: string[] = [];
  const openLocal = JsonStore.open(
    path.join(
      resolveWorkspaceStoragePath(storageRoot, workspaceRoot),
      TEXRA_CONFIG_FILE_NAME,
    ),
  );
  if (!workspaceRoot) {
    const store = yield* openLocal;
    warnings.push(...configFileWarnings(catalog, store, false));
    return { workspace: store, local: store, warnings };
  }
  const projectConfigPath = workspaceTexraConfigPath(workspaceRoot);
  const [workspace, local] = yield* Effect.all(
    [
      JsonStore.open(projectConfigPath).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            warnings.push(
              `Cannot read ${projectConfigPath}; project settings are ignored and cannot be saved until it is fixed. Cause: ${toErrorMessage(error)}`,
            ),
          ).pipe(Effect.andThen(JsonStore.unreadable(projectConfigPath))),
        ),
      ),
      openLocal,
    ],
    { concurrency: 'unbounded' },
  );
  for (const key of workspace.keys()) {
    const row = catalog.byStoredKey(key);
    if (!projectValueIgnored(row, workspace.get(key))) continue;
    warnings.push(
      `Ignoring "${key}" in ${projectConfigPath}: a project file cannot set it. Set it in the settings view or with /config.`,
    );
  }
  warnings.push(
    ...configFileWarnings(catalog, workspace, true),
    ...configFileWarnings(catalog, local, false),
  );
  return { workspace, local, warnings };
});

/**
 * Open the user-level config store under `storageRoot`, which every project
 * of the process reads beneath its own stores. Like the others it follows
 * its file, so a value another window or terminal saves is read. `warnings`
 * names each value its row rejects.
 */
export const openTexraGlobalConfigStore = Effect.fn(
  'nodeStores.openTexraGlobalConfigStore',
)(function* (catalog: SettingsCatalog, storageRoot: string) {
  const store = yield* JsonStore.open(
    path.join(resolveGlobalStoragePath(storageRoot), TEXRA_CONFIG_FILE_NAME),
  );
  return { store, warnings: configFileWarnings(catalog, store, false) };
});

/**
 * Open both stores backing a host's {@link JsonConfigProvider} for the
 * workspace `workspaceRoot` under `storageRoot`. Neither store creates
 * anything on open, so a caller that must not create a directory under the
 * storage root (the CLI's pre-platform startup read, whose `clone` entry may
 * only be able to read it) is served too. `warnings` is what the two opens
 * reported.
 */
export const openTexraConfigStores = Effect.fn(
  'nodeStores.openTexraConfigStores',
)(function* (
  catalog: SettingsCatalog,
  storageRoot: string,
  workspaceRoot: string | undefined,
) {
  const [{ workspace, local, warnings }, global] = yield* Effect.all(
    [
      openTexraWorkspaceConfigStores(catalog, storageRoot, workspaceRoot),
      openTexraGlobalConfigStore(catalog, storageRoot),
    ],
    { concurrency: 'unbounded' },
  );
  return {
    stores: {
      workspace,
      global: global.store,
      local,
      catalog,
    } satisfies JsonConfigProviderOptions,
    warnings: [...warnings, ...global.warnings],
  };
});
