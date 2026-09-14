import { Effect } from 'effect';

import { openAppStateStore } from '@controllers/session/appStateStore';
import { AppState } from '@platform/interfaces';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';

interface CliStateStoresInit {
  readonly storageRoot?: string;
  readonly workspacePath: string | undefined;
}

/**
 * The CLI's two state scopes, each in the `texra.db` of its own storage root:
 * global state beside the update-check and inquiry records, workspace state
 * in the project's storage directory.
 *
 * Global state is the process `AppState` service, opened once when the
 * process runtime built its layer, so this entry and every program below it
 * read and write the one store rather than a second view of the same file.
 */
export const createCliStateStores = Effect.fn(
  'cliStateStores.createCliStateStores',
)(function* (init: CliStateStoresInit) {
  const storage = createNodeStorageProvider({
    storageRoot: init.storageRoot,
    workspacePath: init.workspacePath,
  });
  const [globalState, workspaceState] = yield* Effect.all(
    [AppState, openAppStateStore(storage.getStoragePath())],
    { concurrency: 'unbounded' },
  );
  return { storage, globalState, workspaceState };
});
