/**
 * The JSON stores a Node-family host (CLI, desktop, extension) opens before
 * `initPlatform`.
 *
 * Every host resolves the same files from the same
 * {@link WorkspaceStorageProvider}, so the derivations live here once: which
 * store backs workspace configuration (the project `.texra/config.json` when
 * it is usable, the internal workspace store otherwise), where global
 * configuration lives, and where workspace state lives.
 */

// Node imports
import { access, constants } from 'node:fs/promises';
import * as path from 'node:path';

// Local imports - common
import { isFileNotFoundError } from '@common/errors';

// Local imports - utilities
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { JsonStore } from './jsonStore';
import {
  TEXRA_CONFIG_FILE_NAME,
  workspaceTexraConfigPath,
} from './nodeStorage';
import type { JsonConfigProviderOptions } from './jsonConfigProvider';
import type { WorkspaceStorageProvider } from './workspaceStorage';
import type { StateStore } from '../interfaces';

/** File name of a state store inside a storage directory. */
const STATE_FILE_NAME = 'state.json';

/**
 * Whether a write through a `JsonStore` at `filePath` could succeed:
 * `flush()` creates the containing directory on demand and then writes a temp
 * file into it, so the deepest existing ancestor of `filePath` must be
 * writable and traversable. Answers false for e.g. a read-only checkout
 * without ever creating the directory in the project tree.
 */
async function canCreateOrWrite(filePath: string): Promise<boolean> {
  let dir = path.dirname(filePath);
  // Walk up to the deepest existing ancestor; the workspace root exists, so
  // this terminates after a step or two.
  for (;;) {
    try {
      await access(dir, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      const parent = path.dirname(dir);
      if (!isFileNotFoundError(error) || parent === dir) return false;
      dir = parent;
    }
  }
}

/**
 * Open the store backing the workspace config target. The desktop opens one
 * per paper beside the process-wide global store; single-workspace hosts go
 * through {@link openTexraConfigStores}.
 *
 * `warn` reports why the project store could not be used: falling back to the
 * internal store is a degradation, so every host says so out loud rather than
 * swallowing the cause.
 *
 * A workspace uses its `.texra/config.json`, shared by all three hosts.
 * Sessions without a workspace, read-only projects without an existing
 * config, and projects whose config file cannot be read (missing permissions,
 * malformed JSON) fall back to the internal workspace store so settings stay
 * readable and writable — degraded, never fatal.
 */
export async function openTexraWorkspaceConfigStore(
  workspaceStoragePath: string,
  workspaceRoot: string | undefined,
  warn: (message: string) => void,
): Promise<JsonStore> {
  if (workspaceRoot) {
    const projectConfigPath = workspaceTexraConfigPath(workspaceRoot);
    try {
      const projectStore = await JsonStore.open(projectConfigPath);
      if (
        projectStore.keys().length > 0 ||
        (await canCreateOrWrite(projectConfigPath))
      ) {
        return projectStore;
      }
      warn(
        `Project .texra/config.json is not writable (${projectConfigPath}); using the internal workspace config store.`,
      );
    } catch (error) {
      warn(
        `Cannot open project .texra/config.json; using the internal workspace config store. Cause: ${toErrorMessage(error)}`,
      );
    }
  }
  return JsonStore.open(
    path.join(workspaceStoragePath, TEXRA_CONFIG_FILE_NAME),
  );
}

/** Open both stores backing a host's {@link JsonConfigProvider}. */
export async function openTexraConfigStores(
  storage: WorkspaceStorageProvider,
  workspaceRoot: string | undefined,
  warn: (message: string) => void,
): Promise<JsonConfigProviderOptions> {
  const [workspace, global] = await Promise.all([
    openTexraWorkspaceConfigStore(
      storage.getStoragePath(),
      workspaceRoot,
      warn,
    ),
    JsonStore.open(
      path.join(storage.getGlobalStoragePath(), TEXRA_CONFIG_FILE_NAME),
    ),
  ]);
  return { workspace, global };
}

/**
 * Open the workspace state store. The CLI and desktop hosts address the same
 * physical `<storageRoot>/workspace-storage/<id>/state.json` in production, so
 * the path is derived once here.
 */
export async function openNodeWorkspaceStateStore(
  workspaceStoragePath: string,
): Promise<StateStore> {
  return JsonStore.open(path.join(workspaceStoragePath, STATE_FILE_NAME));
}
