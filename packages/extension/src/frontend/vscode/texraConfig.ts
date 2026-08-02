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
import type { ConfigTarget, StorageProvider } from '@platform/interfaces';
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

export interface ExtensionConfigWorkspaceTransitionHooks {
  readonly workspacePath: string | undefined;
  afterStorageCommit(): Promise<void>;
  afterStorageRollback(): void;
  afterStorageFinalize(): void;
}

export interface ExtensionConfigWorkspaceTransition {
  readonly generation: number;
  readonly completion: Promise<void>;
}

export class ExtensionTexraConfig extends JsonConfigProvider {
  private transitionGeneration = 0;
  private failedTransitionGeneration: number | undefined;
  private readonly workspaceQueue = new PQueue({ concurrency: 1 });

  constructor(
    private readonly storage: StorageProvider,
    workspaceStore: JsonStore,
    globalStore: JsonStore,
  ) {
    super({ workspace: workspaceStore, global: globalStore });
  }

  override async update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Promise<void> {
    if (target === 'global') {
      await super.update(key, value, target);
      return;
    }

    const generation = this.transitionGeneration;
    await this.workspaceQueue.add(async () => {
      if (this.failedTransitionGeneration === generation) {
        throw new Error(
          `Cannot update workspace settings because workspace transition ${generation} failed. Retry the workspace change or restart TeXRA.`,
        );
      }
      await super.update(key, value, target);
    });
  }

  /** Capture and serialize a complete storage/config workspace transition. */
  enqueueWorkspaceTransition(
    workspaceRoot: string | undefined,
    reloadStorage: (
      hooks: ExtensionConfigWorkspaceTransitionHooks,
    ) => Promise<void>,
  ): ExtensionConfigWorkspaceTransition {
    const generation = ++this.transitionGeneration;
    const completion = this.workspaceQueue.add(async () => {
      let previousStore: JsonStore | undefined;
      let finalized = false;
      const rollbackConfig = () => {
        if (previousStore) {
          this.replaceWorkspaceStore(previousStore);
          previousStore = undefined;
        }
      };

      try {
        await reloadStorage({
          workspacePath: workspaceRoot,
          afterStorageCommit: async () => {
            const workspaceStore = await openWorkspaceConfigStore(
              workspaceRoot,
              path.join(this.storage.getStoragePath(), TEXRA_CONFIG_FILE_NAME),
            );
            previousStore = this.replaceWorkspaceStore(workspaceStore);
          },
          afterStorageRollback: rollbackConfig,
          afterStorageFinalize: () => {
            previousStore = undefined;
            finalized = true;
          },
        });
        if (!finalized) {
          throw new Error(
            `Workspace transition ${generation} completed without finalizing storage and configuration.`,
          );
        }
      } catch (error) {
        if (!finalized) {
          rollbackConfig();
          this.failedTransitionGeneration = generation;
        }
        throw error;
      }
    }) as Promise<void>;

    return { generation, completion };
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
