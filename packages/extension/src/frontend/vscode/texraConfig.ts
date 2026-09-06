// Third-party imports
import { Effect } from 'effect';

// Local imports - logging
import { createLog } from '@logger/logUtils';

// Local imports - platform
import { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import { openTexraConfigStores } from '@platform/defaults/nodeStores';
import type { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';

const log = createLog('extension');

/**
 * Open the TeXRA configuration shared by the CLI, extension, and desktop.
 *
 * The workspace scope is pinned for the life of the process, exactly as the
 * storage root is: VS Code restarts the extension host when the first
 * workspace folder changes, so a live provider never has to switch stores.
 */
export const createExtensionTexraConfig = Effect.fn(
  'texraConfig.createExtensionTexraConfig',
)(function* (
  storage: WorkspaceStorageProvider,
  workspaceRoot: string | undefined,
) {
  const stores = yield* openTexraConfigStores(
    storage,
    workspaceRoot,
    (message) => log.warn(message),
  );
  return new JsonConfigProvider(stores);
});
