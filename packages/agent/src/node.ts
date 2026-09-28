import process from 'node:process';

import { Effect } from 'effect';

// Local imports - types
import { SecretsFailed, type PlatformSecrets } from '@platform/secrets';

// Local imports - platform defaults
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@platform/languageModel';
import { mcpConfigPathOf } from '@tools/mcp/mcpConfig';

import type { AgentPlatform } from './index.js';

/** Filesystem locations used by the default Node platform. */
export interface NodePlatformOptions {
  readonly agentsDir: string;
  readonly workspaceDir?: string;
  /**
   * The directory this platform stores run history, checkpoints and its
   * global state under, and reads its `mcp.json` from. Required: the package
   * never falls back to the user's own `~/.texra`, which belongs to the
   * TeXRA hosts.
   */
  readonly storageDir: string;
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

/** Holds nothing; an API key comes from its env var via `resolveCredential`. */
const unpersistedSecrets: PlatformSecrets = {
  get: () => Effect.succeed(undefined),
  set: (key) => unpersisted('set', key),
  delete: (key) => unpersisted('delete', key),
  listStoredKeys: () => Effect.succeed([]),
};

/**
 * Construct the Node services required by the agent package: the process
 * platform plus the workspace roots of `workspaceDir`.
 *
 * Agent definitions are read from `agentsDir`; configuration and state are
 * process-local, while run artifacts use TeXRA's ordinary Node storage layout.
 */
export function nodePlatform(options: NodePlatformOptions): AgentPlatform {
  // Canonical once, here: the storage directory and `roots.workspace` both
  // key on the physical root, as every other host's do.
  const workspaceDir = canonicalizeWorkspacePath(
    options.workspaceDir ?? process.cwd(),
  );
  const globalState = new MemoryStateStore();
  return {
    secrets: unpersistedSecrets,
    // The two process ports `composeProcess` serves: this platform resumes
    // nothing and has no editor behind it.
    agentResume: {
      tryResumeRun: () => Effect.succeed(false),
    },
    languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
    mcpConfigPath: mcpConfigPathOf(options.storageDir),
    agentDirectories: {
      custom: () => Effect.succeed(options.agentsDir),
      customConfigured: () => Effect.succeed(true),
      builtIn: () => Effect.succeed(''),
      builtInToolUse: () => Effect.succeed(''),
    },
    roots: createNodeWorkspaceRoots({
      host: 'sdk',
      workspacePath: workspaceDir,
      storage: resolveWorkspaceStoragePath(options.storageDir, workspaceDir),
      globalStorage: resolveGlobalStoragePath(options.storageDir),
      // Process-local configuration: an embedder's settings must not be read
      // from, or written to, the user's `.texra/config.json`.
      config: new MemoryConfigProvider(),
      workspaceState: new MemoryStateStore(),
      globalState,
    }),
  };
}
