// Node imports
import * as path from 'node:path';

// Local imports - platform
import type { ConfigProvider, StorageProvider } from '@platform/interfaces';
import { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import { JsonStore } from '@platform/defaults/jsonStore';
import {
  TEXRA_CONFIG_FILE_NAME,
  workspaceTexraConfigPath,
} from '@platform/defaults/nodeStorage';

/** Open the TeXRA configuration shared by the CLI, extension, and desktop. */
export async function createExtensionTexraConfig(
  storage: StorageProvider,
  workspaceRoot: string | undefined,
): Promise<ConfigProvider> {
  const workspaceStore = await JsonStore.open(
    workspaceRoot
      ? workspaceTexraConfigPath(workspaceRoot)
      : path.join(storage.getStoragePath(), TEXRA_CONFIG_FILE_NAME),
  );
  const globalStore = await JsonStore.open(
    path.join(storage.getGlobalStoragePath(), TEXRA_CONFIG_FILE_NAME),
  );

  return new JsonConfigProvider({
    workspace: workspaceStore,
    global: globalStore,
  });
}
