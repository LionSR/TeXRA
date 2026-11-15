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
import { Effect } from 'effect';

// Local imports
import {
  JsonStore,
  projectValueIgnored,
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
  type JsonConfigProviderOptions,
} from '@texra-ai/harness/node';
import {
  type SettingsCatalog,
  toErrorMessage,
} from '@texra-ai/harness/schemas';

import {
  TEXRA_CONFIG_FILE_NAME,
  workspaceTexraConfigPath,
} from './nodeStorage';

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
  return { workspace, local, warnings };
});

/**
 * Open both stores backing a host's {@link JsonConfigProvider} for the
 * workspace `workspaceRoot` under `storageRoot`. Neither store creates
 * anything on open, so a caller that must not create a directory under the
 * storage root (the CLI's pre-platform startup read, whose `clone` entry may
 * only be able to read it) is served too. `warnings` is what the workspace
 * open reported.
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
      JsonStore.open(
        path.join(
          resolveGlobalStoragePath(storageRoot),
          TEXRA_CONFIG_FILE_NAME,
        ),
      ),
    ],
    { concurrency: 'unbounded' },
  );
  return {
    stores: {
      workspace,
      global,
      local,
      catalog,
    } satisfies JsonConfigProviderOptions,
    warnings,
  };
});
