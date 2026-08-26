// Local imports - logging
import { createLog } from '@logger/logUtils';

// Local imports - platform
import type { StorageProvider } from '@platform/interfaces';
import { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import { openTexraConfigStores } from '@platform/defaults/nodeStores';

const log = createLog('extension');

/**
 * Open the TeXRA configuration shared by the CLI, extension, and desktop.
 *
 * The workspace scope is pinned for the life of the process, exactly as the
 * storage root is: VS Code restarts the extension host when the first
 * workspace folder changes, so a live provider never has to switch stores.
 */
export async function createExtensionTexraConfig(
  storage: StorageProvider,
  workspaceRoot: string | undefined,
): Promise<JsonConfigProvider> {
  const stores = await openTexraConfigStores(
    storage,
    workspaceRoot,
    (message) => log.warn(message),
  );

  return new JsonConfigProvider({
    workspace: stores.workspace,
    global: stores.global,
  });
}
