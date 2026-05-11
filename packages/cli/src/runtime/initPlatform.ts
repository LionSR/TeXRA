// Local imports - platform
import { EnvSecrets } from '@platform/defaults/envSecrets';
import { createMemoryStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { nodeStorage } from '@platform/defaults/nodeStorage';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { initPlatform, tryPlatform } from '@platform/platform';

// Local imports - agent index
import { bootstrapPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';

// Local imports - auth
import { initializeServerSideKeyAccess } from '@auth/serverKeys';
import { FREE_TIER } from '@auth/sharedConfig';

// Local imports - CLI runtime
import { writeTextStderr } from './logSinks';
import { MemoryConfigProvider } from './memoryStores';

// Type imports - platform and CLI runtime
import type { LifecycleHost } from '@platform/interfaces/lifecycle';
import type { LogBackend } from '@platform/interfaces/log';
import type { CliContext } from './cliContext';

const noopLifecycle: LifecycleHost = {
  onShutdown: () => ({ dispose: () => {} }),
  async runShutdown() {},
};

let bootstrappedResourcesPath: string | undefined;
let serverSideKeysInitialized = false;
let cliWorkspaceCwd = '';

const cliPlatformLog: LogBackend = {
  initialize() {},
  debug: (channel, message) =>
    writeTextStderr(`[debug] [${channel}] ${message}`),
  info: (channel, message) => writeTextStderr(`[info] [${channel}] ${message}`),
  warn: (channel, message) => writeTextStderr(`[warn] [${channel}] ${message}`),
  error: (channel, message) =>
    writeTextStderr(`[error] [${channel}] ${message}`),
};

export async function initCliPlatform(
  context: Pick<CliContext, 'cwd' | 'resourcesPath'>,
): Promise<void> {
  cliWorkspaceCwd = context.cwd;

  if (!tryPlatform()) {
    const globalState = createMemoryStore();
    initPlatform({
      config: new MemoryConfigProvider(),
      globalState,
      workspaceState: createMemoryStore(),
      log: cliPlatformLog,
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => cliWorkspaceCwd),
      storage: nodeStorage,
      secrets: new EnvSecrets(),
      lifecycle: noopLifecycle,
    });
    initializeServerSideKeyAccess(
      {
        state: globalState,
        logger: cliPlatformLog,
      },
      {
        isAuthenticated: async () => false,
        getUserTier: async () => FREE_TIER,
        getAccessToken: async () => null,
      },
    );
    serverSideKeysInitialized = true;
  } else if (!serverSideKeysInitialized) {
    initializeServerSideKeyAccess(
      {
        state: tryPlatform()?.globalState,
        logger: cliPlatformLog,
      },
      {
        isAuthenticated: async () => false,
        getUserTier: async () => FREE_TIER,
        getAccessToken: async () => null,
      },
    );
    serverSideKeysInitialized = true;
  }

  if (bootstrappedResourcesPath !== context.resourcesPath) {
    await bootstrapPlatformAgentDirectories({
      channel: 'cli',
      resourcesPath: context.resourcesPath,
      currentVersion: undefined,
      customDirectoryStore: { get: () => undefined },
      versionStore: {
        get: () => undefined,
        update: async () => {},
      },
    });
    bootstrappedResourcesPath = context.resourcesPath;
  }
}
