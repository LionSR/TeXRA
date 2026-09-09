import * as path from 'node:path';

import { Effect } from 'effect';

import { JsonStore } from '@platform/defaults/jsonStore';
import { openNodeWorkspaceStateStore } from '@platform/defaults/nodeStores';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';

interface CliStateStoresInit {
  readonly storageRoot?: string;
  readonly workspacePath: string | undefined;
}

export const createCliStateStores = Effect.fn(
  'cliStateStores.createCliStateStores',
)(function* (init: CliStateStoresInit) {
  const storage = createNodeStorageProvider({
    storageRoot: init.storageRoot,
    workspacePath: init.workspacePath,
  });
  const [globalState, workspaceState] = yield* Effect.all(
    [
      JsonStore.open(path.join(storage.getGlobalStoragePath(), 'state.json')),
      openNodeWorkspaceStateStore(storage.getStoragePath()),
    ],
    { concurrency: 'unbounded' },
  );
  return { storage, globalState, workspaceState };
});
