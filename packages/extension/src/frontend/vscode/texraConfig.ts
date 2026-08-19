// Third-party imports
import PQueue from 'p-queue';

// Local imports - agent
import {
  tryDefaultSession,
  type WorkspaceStorageTransitionHooks,
} from '@agent/runtime';

// Local imports - eventBus
import { appSignals } from '@eventBus/AppSignals';

// Local imports - logging
import { createLog } from '@logger/logUtils';

// Local imports - platform
import type { ConfigTarget, StorageProvider } from '@platform/interfaces';
import {
  JsonConfigProvider,
  type ConfigStore,
} from '@platform/defaults/jsonConfigProvider';
import {
  openTexraConfigStores,
  openTexraWorkspaceConfigStore,
} from '@platform/defaults/nodeStores';
import { readPersistedTexraApprovalPolicy } from '@shared/approvalPolicy';

const log = createLog('extension');

const warnConfigDegradation = (message: string): void => log.warn(message);

export class ExtensionTexraConfig extends JsonConfigProvider {
  private transitionGeneration = 0;
  private failedTransitionGeneration: number | undefined;
  private readonly workspaceQueue = new PQueue({ concurrency: 1 });

  constructor(
    private readonly storage: StorageProvider,
    workspaceStore: ConfigStore,
    globalStore: ConfigStore,
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
    reloadStorage: (hooks: WorkspaceStorageTransitionHooks) => Promise<void>,
  ): { readonly generation: number; readonly completion: Promise<void> } {
    const generation = ++this.transitionGeneration;
    const completion = this.workspaceQueue.add(async () => {
      if (
        this.storage.hasPendingWorkspaceStorageChange?.({
          workspacePath: workspaceRoot,
        }) === false
      ) {
        return;
      }

      let previousStore: ConfigStore | undefined;
      let finalized = false;
      const seedSessionApprovalPolicy = (): void => {
        // No default session exists yet during activation's own config setup,
        // and unit tests exercise transitions without one; a live session
        // always exists by the time a real workspace-folder change can fire.
        tryDefaultSession()?.setApprovalPolicy(
          readPersistedTexraApprovalPolicy((key, fallback) =>
            this.get(key, fallback),
          ),
        );
        appSignals.emit('approvalPolicyChanged', undefined);
      };
      const rollbackConfig = () => {
        if (!previousStore) return;
        this.replaceWorkspaceStore(previousStore);
        previousStore = undefined;
        // Commit may have already re-seeded from the new workspace; restore
        // the session + tooltip to match the rolled-back config store.
        seedSessionApprovalPolicy();
      };

      try {
        await reloadStorage({
          workspacePath: workspaceRoot,
          afterStorageCommit: async () => {
            const workspaceStore = await openTexraWorkspaceConfigStore(
              this.storage,
              workspaceRoot,
              warnConfigDegradation,
            );
            previousStore = this.replaceWorkspaceStore(workspaceStore);
            seedSessionApprovalPolicy();
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
  const stores = await openTexraConfigStores(
    storage,
    workspaceRoot,
    warnConfigDegradation,
  );

  return new ExtensionTexraConfig(storage, stores.workspace, stores.global);
}
