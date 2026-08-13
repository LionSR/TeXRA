import process from 'node:process';

// Local imports - types
import type { Platform } from '@platform/platform';
import type { PlatformSecrets } from '@platform/secrets';

// Local imports - platform defaults
import { NO_TOOL_AVAILABILITY_HOST } from '@platform/interfaces';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@platform/languageModel';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFileLocks } from '@platform/defaults/fileLocks';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import {
  createNodeStorageProvider,
  DEFAULT_NODE_STORAGE_ROOT,
} from '@platform/defaults/nodeStorage';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';

/** Filesystem locations used by the default Node platform. */
export interface NodePlatformOptions {
  readonly agentsDir: string;
  readonly workspaceDir?: string;
  readonly storageDir?: string;
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
