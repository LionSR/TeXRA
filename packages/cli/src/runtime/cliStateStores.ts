import { Effect } from 'effect';

import { openAppStateStore } from '@controllers/session/appStateStore';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';

interface CliWorkspaceStateInit {
  readonly storageRoot?: string;
  readonly workspacePath: string | undefined;
}

/**
 * The CLI's workspace state scope, in the `texra.db` of the project's storage
 * directory, beside the storage provider that named it. The global scope is
 * not opened here: it is the store `installCliProcessRuntime` opens before it
 * installs the runtime that serves it as `AppState`, and this root takes it
 * from there.
 */
export const openCliWorkspaceState = Effect.fn(
  'cliStateStores.openCliWorkspaceState',
)(function* (init: CliWorkspaceStateInit) {
  const storage = createNodeStorageProvider({
    storageRoot: init.storageRoot,
    workspacePath: init.workspacePath,
  });
  const workspaceState = yield* openAppStateStore(storage.getStoragePath());
  return { storage, workspaceState };
});
