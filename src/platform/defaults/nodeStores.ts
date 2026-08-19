/**
 * The JSON stores a Node-family host (CLI, desktop, extension) opens before
 * `initPlatform`.
 *
 * Every host resolves the same files from the same {@link StorageProvider},
 * so the derivations live here once: which store backs workspace
 * configuration (the project `.texra/config.json` when it is usable, the
 * internal workspace store otherwise), where global configuration lives, and
 * where workspace state lives.
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
import type { StateStore, StorageProvider } from '../interfaces';

/** File name of a state store inside a storage directory. */
const STATE_FILE_NAME = 'state.json';

/**
 * Reports why the project config store could not be used. Falling back to the
 * internal store is a degradation, so every host has to say so out loud rather
 * than swallow the cause.
 */
export type ConfigStoreWarn = (message: string) => void;

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
 * Open the store backing the workspace config target.
 *
 * A workspace uses its `.texra/config.json`, shared by all three hosts.
 * Sessions without a workspace, read-only projects without an existing
 * config, and projects whose config file cannot be read (missing permissions,
 * malformed JSON) fall back to the internal workspace store so settings stay
 * readable and writable — degraded, never fatal.
 */
export async function openTexraWorkspaceConfigStore(
  storage: StorageProvider,
  workspaceRoot: string | undefined,
  warn: ConfigStoreWarn,
): Promise<JsonStore> {
  if (workspaceRoot) {
    const projectConfigPath = workspaceTexraConfigPath(workspaceRoot);
    try {
      const projectStore = await JsonStore.open(projectConfigPath);
      if (
        Object.keys(projectStore.snapshot()).length > 0 ||
        (await canCreateOrWrite(projectConfigPath))
      ) {
        return projectStore;
      }
    } catch (error) {
      warn(
        `Cannot open project .texra/config.json; using the internal workspace config store. Cause: ${toErrorMessage(error)}`,
      );
    }
  }
  return JsonStore.open(
    path.join(storage.getStoragePath(), TEXRA_CONFIG_FILE_NAME),
  );
}

/** Open both stores backing a host's {@link JsonConfigProvider}. */
export async function openTexraConfigStores(
  storage: StorageProvider,
  workspaceRoot: string | undefined,
  warn: ConfigStoreWarn,
): Promise<JsonConfigProviderOptions> {
  const [workspace, global] = await Promise.all([
    openTexraWorkspaceConfigStore(storage, workspaceRoot, warn),
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
  storage: StorageProvider,
): Promise<StateStore> {
  return JsonStore.open(path.join(storage.getStoragePath(), STATE_FILE_NAME));
}
