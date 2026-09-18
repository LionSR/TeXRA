import process from 'node:process';

import { Effect } from 'effect';

// Local imports - types
import { SecretsFailed, type PlatformSecrets } from '@platform/secrets';

// Local imports - platform defaults
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import {
  createNodeStorageProvider,
  DEFAULT_NODE_STORAGE_ROOT,
} from '@platform/defaults/nodeStorage';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@platform/languageModel';

import type { AgentPlatform } from './index.js';

/** Filesystem locations used by the default Node platform. */
export interface NodePlatformOptions {
  readonly agentsDir: string;
  readonly workspaceDir?: string;
  readonly storageDir?: string;
}

const NO_PERSISTED_SECRETS =
  'The default Node platform does not persist secrets.';

const unpersisted = (operation: 'set' | 'delete', key: string) =>
  Effect.fail(
    new SecretsFailed({
      reason: 'store-unavailable',
      operation,
      key,
      message: NO_PERSISTED_SECRETS,
    }),
  );

const environmentSecrets: PlatformSecrets = {
  get: (key) => Effect.sync(() => process.env[key]),
  getStored: () => Effect.succeed(undefined),
  set: (key) => unpersisted('set', key),
  delete: (key) => unpersisted('delete', key),
  listStoredKeys: () => Effect.succeed([]),
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
  const globalState = new MemoryStateStore();
  const storage = createNodeStorageProvider({
    storageRoot: options.storageDir ?? DEFAULT_NODE_STORAGE_ROOT,
    workspacePath: workspaceDir,
  });
  return {
    secrets: environmentSecrets,
    // The two process ports `composeProcess` serves: this platform resumes
    // nothing and has no editor behind it.
    agentResume: {
      tryResumeRun: () => Effect.succeed(false),
    },
    languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
    lifecycle: createLifecycleHost(),
    agentDirectories: {
      custom: () => Effect.succeed(options.agentsDir),
      builtIn: () => Effect.succeed(''),
      builtInToolUse: () => Effect.succeed(''),
    },
    roots: createNodeWorkspaceRoots({
      workspacePath: workspaceDir,
      storage: storage.getStoragePath(),
      globalStorage: storage.getGlobalStoragePath(),
      // Process-local configuration: an embedder's settings must not be read
      // from, or written to, the user's `.texra/config.json`.
      config: new MemoryConfigProvider(),
      workspaceState: new MemoryStateStore(),
      globalState,
    }),
  };
}
