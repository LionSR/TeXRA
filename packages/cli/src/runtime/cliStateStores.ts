import { Effect } from 'effect';

import { openProjectStateStore } from '@controllers/session/appStateStore';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';

interface CliWorkspaceStateInit {
  readonly storageRoot?: string;
  readonly workspacePath: string | undefined;
}

/**
 * The CLI's workspace state scope, in the `texra.db` of the project's storage
 * directory, beside the storage provider that named it. The global scope is
 * not opened here: the process runtime derives AppState from GlobalDatabase.
 * The caller retains this database through the scope owning its project session.
 */
export const openCliWorkspaceState = Effect.fn(
  'cliStateStores.openCliWorkspaceState',
)(function* (init: CliWorkspaceStateInit) {
  const storage = createNodeStorageProvider({
    storageRoot: init.storageRoot,
    workspacePath: init.workspacePath,
  });
  const workspaceState = yield* openProjectStateStore(storage.getStoragePath());
  return { storage, workspaceState };
});
