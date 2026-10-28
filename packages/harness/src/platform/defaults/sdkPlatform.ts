/** The default Node platform of an SDK embedder: process-local, no secrets. */
import process from 'node:process';

import { Effect } from 'effect';

// Local imports - types
import { SecretsFailed } from '@texra-ai/llm';
import type { PlatformSecrets } from '@platform/secrets';

// Local imports - platform defaults
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import { resolveWorkspaceStoragePath } from '@platform/defaults/workspaceStorage';
import {
  settingsCatalog,
  type SettingsCatalog,
} from '@shared/state/stateSettings';
import { canonicalizeWorkspacePath } from '@utils/system/nodeWorkspace';

import type { AgentPlatform } from '../../effect/sessions.js';

/** Filesystem locations used by the default Node platform. */
export interface NodePlatformOptions {
  readonly agentsDir: string;
  readonly workspaceDir?: string;
  /**
   * The directory this platform stores run history, checkpoints and its
   * global state under, and reads its `mcp.json` from. Required: the package
   * never falls back to a per-user default directory.
   */
  readonly storageDir: string;
  /** The catalog the platform's config resolves against (`settingsCatalog`);
   *  absent, the harness's rows alone, under the `harness` namespace. */
  readonly settings?: SettingsCatalog;
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
 * process-local, while run artifacts use the ordinary Node storage layout.
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
    agentDirectories: {
      custom: () => Effect.succeed(options.agentsDir),
      customConfigured: () => Effect.succeed(true),
      builtIn: () => Effect.succeed(''),
    },
    roots: createNodeWorkspaceRoots({
      workspacePath: workspaceDir,
      storage: resolveWorkspaceStoragePath(options.storageDir, workspaceDir),
      storageRoot: options.storageDir,
      // Process-local configuration: an embedder's settings must not be read
      // from, or written to, the user's `.texra/config.json`.
      config: new MemoryConfigProvider(
        options.settings ?? settingsCatalog({ namespace: 'harness', rows: [] }),
      ),
      workspaceState: new MemoryStateStore(),
      repoState: new MemoryStateStore(),
      globalState,
    }),
  };
}
