import * as path from 'node:path';

import type { StateStore, StorageProvider } from '@platform/interfaces';
import { JsonStore } from '@platform/defaults/jsonStore';
import { openNodeWorkspaceStateStore } from '@platform/defaults/nodeStores';
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

/** Open the CLI's global `state.json` under the given storage provider. This
 *  is the single derivation of the global state path; pre-platform-init callers
 *  (e.g. the update checker) use it with a default provider instead of
 *  re-deriving the same path by hand. */
export async function openCliGlobalStateStore(
  storage: StorageProvider,
): Promise<StateStore> {
  return JsonStore.open(
    path.join(storage.getGlobalStoragePath(), 'state.json'),
  );
}

export async function createCliStateStores(
  init: CliStateStoresInit,
): Promise<CliStateStores> {
  const storage = createNodeStorageProvider({
    storageRoot: init.storageRoot,
    workspacePath: init.workspacePath,
  });
  const [globalStore, workspaceStore] = await Promise.all([
    openCliGlobalStateStore(storage),
    openNodeWorkspaceStateStore(storage),
  ]);

  return {
    storage,
    globalState: globalStore,
    workspaceState: workspaceStore,
  };
}
