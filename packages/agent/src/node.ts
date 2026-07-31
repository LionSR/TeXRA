import process from 'node:process';

// Local imports - types
import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
  Disposable,
} from '@platform/interfaces';
import type { Platform } from '@platform/platform';
import type { PlatformSecrets } from '@platform/secrets';

// Local imports - platform defaults
import { NO_TOOL_AVAILABILITY_HOST } from '@platform/interfaces';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@platform/languageModel';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFileLocks } from '@platform/defaults/fileLocks';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import {
  createNodeStorageProvider,
  DEFAULT_NODE_STORAGE_ROOT,
} from '@platform/defaults/nodeStorage';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import type { ConfigKeyValueStore } from '@shared/config/configKeys';
import {
  canonicalConfigKey,
  configKeyVariants,
  createWatcherRegistry,
  firstStoredValue,
} from '@shared/config/configKeys';

/** Filesystem locations used by the default Node platform. */
export interface NodePlatformOptions {
  readonly agentsDir: string;
  readonly workspaceDir?: string;
  readonly storageDir?: string;
}

function asConfigKeyValueStore(
  map: ReadonlyMap<string, unknown>,
): ConfigKeyValueStore {
  return {
    has: (key) => map.has(key),
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
  };
}

class MemoryConfigProvider implements ConfigProvider {
  private readonly global = new Map<string, unknown>();
  private readonly workspace = new Map<string, unknown>();
  private readonly globalStore = asConfigKeyValueStore(this.global);
  private readonly workspaceStore = asConfigKeyValueStore(this.workspace);
  private readonly watchers = createWatcherRegistry();

  get<T>(key: string, defaultValue?: T): T {
    const keys = configKeyVariants(key);
    const workspaceValue = firstStoredValue<T>(this.workspaceStore, keys);
    if (workspaceValue !== undefined) return workspaceValue;
    const globalValue = firstStoredValue<T>(this.globalStore, keys);
    if (globalValue !== undefined) return globalValue;
    return defaultValue as T;
  }

  async update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Promise<void> {
    const values = target === 'global' ? this.global : this.workspace;
    const keys = configKeyVariants(key);
    if (value === undefined) {
      for (const candidate of keys) values.delete(candidate);
    } else {
      const storedKey =
        keys.find((candidate) => values.has(candidate)) ??
        canonicalConfigKey(key);
      values.set(storedKey, value);
    }
    this.watchers.notify(canonicalConfigKey(key));
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> {
    const keys = configKeyVariants(key);
    return {
      globalValue: firstStoredValue<T>(this.globalStore, keys),
      workspaceValue: firstStoredValue<T>(this.workspaceStore, keys),
      effectiveValue: this.get<T>(key),
    };
  }

  isExplicitlySet(key: string): boolean {
    return configKeyVariants(key).some(
      (candidate) =>
        this.workspace.has(candidate) || this.global.has(candidate),
    );
  }

  watch(
    key: string | readonly string[] | RegExp,
    listener: () => void,
  ): Disposable {
    return this.watchers.add({ key, listener });
  }
}

const environmentSecrets: PlatformSecrets = {
  get: async (key) => process.env[key],
  getStored: async () => undefined,
  set: async () => {
    throw new Error('The default Node platform does not persist secrets.');
  },
  delete: async () => {
    throw new Error('The default Node platform does not persist secrets.');
  },
  listStoredKeys: async () => [],
  getEnv: (name) => process.env[name],
};

/**
 * Construct the Node services required by the agent package.
 *
 * Agent definitions are read from `agentsDir`; configuration and state are
 * process-local, while run artifacts use TeXRA's ordinary Node storage layout.
 */
export function nodePlatform(options: NodePlatformOptions): Platform {
  const workspaceDir = options.workspaceDir ?? process.cwd();
  const storageDir = options.storageDir ?? DEFAULT_NODE_STORAGE_ROOT;
  const globalState = new MemoryStateStore();
  const workspaceState = new MemoryStateStore();
  const storage = createNodeStorageProvider({
    storageRoot: storageDir,
    workspacePath: workspaceDir,
  });
  const lifecycle = createLifecycleHost();

  return {
    config: new MemoryConfigProvider(),
    globalState,
    workspaceState,
    fs: nodeFilesystem,
    workspace: createNodeWorkspace(() => workspaceDir),
    storage,
    fileLocks: nodeFileLocks,
    secrets: environmentSecrets,
    lifecycle,
    agentResume: {
      tryResumeStream: async () => false,
    },
    agentDirectories: {
      custom: async () => options.agentsDir,
      builtIn: async () => '',
      builtInToolUse: async () => '',
    },
    languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
    toolAvailability: NO_TOOL_AVAILABILITY_HOST,
  };
}
