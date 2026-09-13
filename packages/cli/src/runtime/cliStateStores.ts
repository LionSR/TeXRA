import { Effect } from 'effect';

import {
  openAppStateStore,
  type RunStateWrite,
} from '@controllers/session/appStateStore';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';

interface CliStateStoresInit {
  readonly storageRoot?: string;
  readonly workspacePath: string | undefined;
  /** The entry's run of a durable state write: the store is below the
   *  boundary and never runs an Effect of its own. */
  readonly runWrite: RunStateWrite;
}

/**
 * The CLI's two state scopes, each in the `texra.db` of its own storage root:
 * global state beside the update-check and inquiry records, workspace state
 * in the project's storage directory.
 */
export const createCliStateStores = Effect.fn(
  'cliStateStores.createCliStateStores',
)(function* (init: CliStateStoresInit) {
  const storage = createNodeStorageProvider({
    storageRoot: init.storageRoot,
    workspacePath: init.workspacePath,
  });
  const [globalState, workspaceState] = yield* Effect.all(
    [
      openAppStateStore(storage.getGlobalStoragePath(), init.runWrite),
      openAppStateStore(storage.getStoragePath(), init.runWrite),
    ],
    { concurrency: 'unbounded' },
  );
  return { storage, globalState, workspaceState };
});
