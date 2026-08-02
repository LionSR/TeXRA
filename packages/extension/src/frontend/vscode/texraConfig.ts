// Node imports
import { access, constants } from 'node:fs/promises';
import * as path from 'node:path';

// Local imports - common
import { isFileNotFoundError } from '@common/errors';

// Local imports - logging
import * as logger from '@logger/logUtils';

// Local imports - platform
import type { ConfigProvider, StorageProvider } from '@platform/interfaces';
import { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import { JsonStore } from '@platform/defaults/jsonStore';
import {
  TEXRA_CONFIG_FILE_NAME,
  workspaceTexraConfigPath,
} from '@platform/defaults/nodeStorage';

// Local imports - utilities
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Whether JsonStore can create its file beneath the deepest existing directory. */
async function canCreateOrWrite(filePath: string): Promise<boolean> {
  let dir = path.dirname(filePath);
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

/** Open the TeXRA configuration shared by the CLI, extension, and desktop. */
export async function createExtensionTexraConfig(
  storage: StorageProvider,
  workspaceRoot: string | undefined,
): Promise<ConfigProvider> {
  const internalWorkspaceConfigPath = path.join(
    storage.getStoragePath(),
    TEXRA_CONFIG_FILE_NAME,
  );
  let workspaceStore: JsonStore | undefined;
  if (workspaceRoot) {
    const projectConfigPath = workspaceTexraConfigPath(workspaceRoot);
    try {
      const projectStore = await JsonStore.open(projectConfigPath);
      if (
        Object.keys(projectStore.snapshot()).length > 0 ||
        (await canCreateOrWrite(projectConfigPath))
      ) {
        workspaceStore = projectStore;
      }
    } catch (error) {
      logger.warn(
        'extension',
        `Cannot open project .texra/config.json; using the internal workspace config store. Cause: ${toErrorMessage(error)}`,
      );
    }
  }
  workspaceStore ??= await JsonStore.open(internalWorkspaceConfigPath);
  const globalStore = await JsonStore.open(
    path.join(storage.getGlobalStoragePath(), TEXRA_CONFIG_FILE_NAME),
  );

  return new JsonConfigProvider({
    workspace: workspaceStore,
    global: globalStore,
  });
}
