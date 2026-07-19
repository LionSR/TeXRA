import * as path from 'node:path';

import type { StateStore, StorageProvider } from '@platform/interfaces';
import { JsonStore } from '@platform/defaults/jsonStore';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';

export interface CliStateStores {
  readonly storage: StorageProvider;
  readonly globalState: StateStore;
  readonly workspaceState: StateStore;
}

export interface CliStateStoresInit {
  readonly storageRoot?: string;
  readonly workspacePath: string | (() => string | undefined);
}

export async function createCliStateStores(
  init: CliStateStoresInit,
): Promise<CliStateStores> {
  const storage = createNodeStorageProvider({
    storageRoot: init.storageRoot,
    workspacePath: init.workspacePath,
  });
  const [globalStore, workspaceStore] = await Promise.all([
    JsonStore.open(path.join(storage.getGlobalStoragePath(), 'state.json')),
    JsonStore.open(path.join(storage.getStoragePath(), 'state.json')),
  ]);

  return {
    storage,
    globalState: globalStore,
    workspaceState: workspaceStore,
  };
}
