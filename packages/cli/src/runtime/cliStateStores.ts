import * as path from 'node:path';

import { JsonStore } from '@platform/defaults/jsonStore';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';

import type { StateStore } from '@platform/interfaces/state';
import type { StorageProvider } from '@platform/interfaces/storage';

class CliJsonStateStore implements StateStore {
  constructor(private readonly store: JsonStore) {}

  get<T>(key: string, defaultValue?: T): T {
    return this.store.get(key, defaultValue);
  }

  update(key: string, value: unknown): PromiseLike<void> {
    return this.store.set(key, value);
  }
}

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
    globalState: new CliJsonStateStore(globalStore),
    workspaceState: new CliJsonStateStore(workspaceStore),
  };
}
