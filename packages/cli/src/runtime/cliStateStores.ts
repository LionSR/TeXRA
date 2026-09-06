import * as path from 'node:path';

import { Effect } from 'effect';

import type { StorageProvider } from '@platform/interfaces';
import { JsonStore } from '@platform/defaults/jsonStore';
import { openNodeWorkspaceStateStore } from '@platform/defaults/nodeStores';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';

interface CliStateStoresInit {
  readonly storageRoot?: string;
  readonly workspacePath: string | undefined;
}

/** Open the CLI's global `state.json` under the given storage provider. This
 *  is the single derivation of the global state path; pre-platform-init callers
 *  (e.g. the update checker) use it with a default provider instead of
 *  re-deriving the same path by hand. */
export const openCliGlobalStateStore = Effect.fn(
  'cliStateStores.openCliGlobalStateStore',
)(function* (storage: StorageProvider) {
  return yield* JsonStore.open(
    path.join(storage.getGlobalStoragePath(), 'state.json'),
  );
});

export const createCliStateStores = Effect.fn(
  'cliStateStores.createCliStateStores',
)(function* (init: CliStateStoresInit) {
  const storage = createNodeStorageProvider({
    storageRoot: init.storageRoot,
    workspacePath: init.workspacePath,
  });
  const [globalState, workspaceState] = yield* Effect.all(
    [
      openCliGlobalStateStore(storage),
      openNodeWorkspaceStateStore(storage.getStoragePath()),
    ],
    { concurrency: 'unbounded' },
  );
  return { storage, globalState, workspaceState };
});
