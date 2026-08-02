// Node imports
import { access, constants } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import PQueue from 'p-queue';

// Local imports - common
import { isFileNotFoundError } from '@common/errors';

// Local imports - logging
import * as logger from '@logger/logUtils';

// Local imports - platform
import type { StorageProvider } from '@platform/interfaces';
import { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import { JsonStore } from '@platform/defaults/jsonStore';
import {
  TEXRA_CONFIG_FILE_NAME,
  workspaceTexraConfigPath,
} from '@platform/defaults/nodeStorage';

// Local imports - utilities
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Whether JsonStore can create its file beneath the deepest existing directory. */
async function canCreateOrWrite(filePath: string): Promise<boolean> {
  let dir = path.dirname(filePath);
  for (;;) {
    try {
      await access(dir, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      const parent = path.dirname(dir);
      if (!isFileNotFoundError(error) || parent === dir) return false;
      dir = parent;
    }
  }
}

async function openWorkspaceConfigStore(
  workspaceRoot: string | undefined,
  internalConfigPath: string,
): Promise<JsonStore> {
  if (workspaceRoot) {
    const projectConfigPath = workspaceTexraConfigPath(workspaceRoot);
    try {
      const projectStore = await JsonStore.open(projectConfigPath);
      if (
        Object.keys(projectStore.snapshot()).length > 0 ||
        (await canCreateOrWrite(projectConfigPath))
      ) {
        return projectStore;
      }
    } catch (error) {
      logger.warn(
        'extension',
        `Cannot open project .texra/config.json; using the internal workspace config store. Cause: ${toErrorMessage(error)}`,
      );
    }
  }
  return JsonStore.open(internalConfigPath);
}

export class ExtensionTexraConfig extends JsonConfigProvider {
  private readonly rebindQueue = new PQueue({ concurrency: 1 });

  constructor(
    private readonly storage: StorageProvider,
    workspaceStore: JsonStore,
    globalStore: JsonStore,
  ) {
    super({ workspace: workspaceStore, global: globalStore });
  }

  /** Follow VS Code after its workspace-storage replacement has committed. */
  rebindWorkspace(workspaceRoot: string | undefined): Promise<void> {
    return this.rebindQueue.add(async () => {
      if (this.storage.hasPendingWorkspaceStorageChange?.()) {
        throw new Error(
          'Cannot rebind TeXRA settings before the workspace storage change commits.',
        );
      }
      const workspaceStore = await openWorkspaceConfigStore(
        workspaceRoot,
        path.join(this.storage.getStoragePath(), TEXRA_CONFIG_FILE_NAME),
      );
      this.replaceWorkspaceStore(workspaceStore);
    }) as Promise<void>;
  }
}

/** Open the TeXRA configuration shared by the CLI, extension, and desktop. */
export async function createExtensionTexraConfig(
  storage: StorageProvider,
  workspaceRoot: string | undefined,
): Promise<ExtensionTexraConfig> {
  const workspaceStore = await openWorkspaceConfigStore(
    workspaceRoot,
    path.join(storage.getStoragePath(), TEXRA_CONFIG_FILE_NAME),
  );
  const globalStore = await JsonStore.open(
    path.join(storage.getGlobalStoragePath(), TEXRA_CONFIG_FILE_NAME),
  );

  return new ExtensionTexraConfig(storage, workspaceStore, globalStore);
}
