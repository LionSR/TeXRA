import process from 'node:process';

// Local imports - types
import type { PlatformSecrets } from '@platform/secrets';

// Local imports - platform defaults
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import {
  createNodePlatform,
  createNodeWorkspaceRoots,
} from '@platform/defaults/nodeHost';
import {
  createNodeStorageProvider,
  DEFAULT_NODE_STORAGE_ROOT,
} from '@platform/defaults/nodeStorage';

import type { AgentPlatform } from './index.js';

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
 * Construct the Node services required by the agent package: the process
 * platform plus the workspace roots of `workspaceDir`.
 *
 * Agent definitions are read from `agentsDir`; configuration and state are
 * process-local, while run artifacts use TeXRA's ordinary Node storage layout.
 */
export function nodePlatform(options: NodePlatformOptions): AgentPlatform {
  const workspaceDir = options.workspaceDir ?? process.cwd();
  const storage = createNodeStorageProvider({
    storageRoot: options.storageDir ?? DEFAULT_NODE_STORAGE_ROOT,
    workspacePath: workspaceDir,
  });
  return {
    ...createNodePlatform({
      globalState: new MemoryStateStore(),
      storage,
      secrets: environmentSecrets,
      lifecycle: createLifecycleHost(),
      agentResume: {
        tryResumeStream: async () => false,
      },
      agentDirectories: {
        custom: async () => options.agentsDir,
        builtIn: async () => '',
        builtInToolUse: async () => '',
      },
    }),
    roots: createNodeWorkspaceRoots({
      workspacePath: workspaceDir,
      storage: storage.getStoragePath(),
      // Process-local configuration: an embedder's settings must not be read
      // from, or written to, the user's `.texra/config.json`.
      config: new MemoryConfigProvider(),
      workspaceState: new MemoryStateStore(),
    }),
  };
}
