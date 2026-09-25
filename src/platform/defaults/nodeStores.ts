/**
 * The JSON stores a Node-family host (CLI, desktop, extension) opens while
 * it composes its process.
 *
 * Every host resolves the same files from the same storage root, so the
 * derivations live here once: which
 * store backs workspace configuration (the project `.texra/config.json`, or
 * the internal workspace store when there is no workspace), where global
 * configuration lives. Workspace and global state are not here: they are rows
 * in the root's database (`@controllers/session/appStateStore`), not files.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports - utilities
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { JsonStore } from './jsonStore';
import {
  TEXRA_CONFIG_FILE_NAME,
  workspaceTexraConfigPath,
} from './nodeStorage';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from './workspaceStorage';
import type { JsonConfigProviderOptions } from './jsonConfigProvider';

/**
 * Open the store backing the workspace config target. The desktop opens one
 * per paper beside the process-wide global store; single-workspace hosts go
 * through {@link openTexraConfigStores}.
 *
 * One home per workspace, fixed by one rule: a workspace's configuration is
 * its `.texra/config.json`, the committable project file all three hosts
 * share; only a session without a workspace uses the internal workspace
 * store. The home is never chosen by writability, so no value can be stranded
 * in a store another open did not pick. A read-only project reads its file
 * and fails loudly at the first write. A file that cannot be read (missing
 * permissions, malformed JSON) is reported through `warn` and serves as an
 * empty, effectively read-only view: every write re-reads the file and fails
 * rather than overwriting it.
 *
 * No write runner is supplied: a config store is written through the store's
 * own Effect `set`, which composes into the writer's program.
 */
export function openTexraWorkspaceConfigStore(
  workspaceStoragePath: string,
  workspaceRoot: string | undefined,
  warn: (message: string) => void,
) {
  if (!workspaceRoot) {
    return JsonStore.open(
      path.join(workspaceStoragePath, TEXRA_CONFIG_FILE_NAME),
    );
  }
  const projectConfigPath = workspaceTexraConfigPath(workspaceRoot);
  return JsonStore.open(projectConfigPath, {
    onUnreadable: (error) =>
      warn(
        `Cannot read ${projectConfigPath}; project settings are ignored and cannot be saved until it is fixed. Cause: ${toErrorMessage(error)}`,
      ),
  });
}

/**
 * Open both stores backing a host's {@link JsonConfigProvider} for the
 * workspace `workspaceRoot` under `storageRoot`. Neither store creates
 * anything on open, so a caller that must not create a directory under the
 * storage root (the CLI's pre-platform startup read, whose `clone` entry may
 * only be able to read it) is served too.
 */
export const openTexraConfigStores = Effect.fn(
  'nodeStores.openTexraConfigStores',
)(function* (
  storageRoot: string,
  workspaceRoot: string | undefined,
  warn: (message: string) => void,
) {
  const [workspace, global] = yield* Effect.all(
    [
      openTexraWorkspaceConfigStore(
        resolveWorkspaceStoragePath(storageRoot, workspaceRoot),
        workspaceRoot,
        warn,
      ),
      JsonStore.open(
        path.join(
          resolveGlobalStoragePath(storageRoot),
          TEXRA_CONFIG_FILE_NAME,
        ),
      ),
    ],
    { concurrency: 'unbounded' },
  );
  return { workspace, global } satisfies JsonConfigProviderOptions;
});
