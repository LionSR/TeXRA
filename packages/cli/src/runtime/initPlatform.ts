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
import {
  getServerSideKeyService,
  initializeServerSideKeyAccess,
} from '@auth/serverKeys';
import { FREE_TIER } from '@auth/sharedConfig';
import type { AuthProvider } from '@auth/serverKeys';

// Local imports - common state
import { GlobalStateKey } from '@common/state/stateKeys';

// Local imports - logger
import { setOutputChannelFactory } from '@logger/logUtils';

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
let quietPlatformLogs = false;

const cliPlatformLog: LogBackend = {
  initialize() {},
  debug: (channel, message) =>
    quietPlatformLogs
      ? undefined
      : writeTextStderr(`[debug] [${channel}] ${message}`),
  info: (channel, message) =>
    quietPlatformLogs
      ? undefined
      : writeTextStderr(`[info] [${channel}] ${message}`),
  warn: (channel, message) =>
    quietPlatformLogs
      ? undefined
      : writeTextStderr(`[warn] [${channel}] ${message}`),
  error: (channel, message) =>
    writeTextStderr(`[error] [${channel}] ${message}`),
};

const cliAuthProvider: AuthProvider = {
  isAuthenticated: async () => false,
  getUserTier: async () => FREE_TIER,
  getAccessToken: async () => null,
};

export async function setCliHelperModel(
  model: string | undefined,
): Promise<void> {
  if (!model) return;
  await tryPlatform()?.globalState.update(GlobalStateKey.HELPER_MODEL, model);
}

export async function initCliPlatform(
  context: Pick<
    CliContext,
    'cwd' | 'resourcesPath' | 'helperModel' | 'quietLogs'
  >,
): Promise<void> {
  cliWorkspaceCwd = context.cwd;
  quietPlatformLogs = context.quietLogs ?? false;
  setOutputChannelFactory(
    quietPlatformLogs ? () => ({ appendLine: () => undefined }) : null,
  );

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
      cliAuthProvider,
    );
    serverSideKeysInitialized = true;
  } else if (!serverSideKeysInitialized) {
    initializeServerSideKeyAccess(
      {
        state: tryPlatform()?.globalState,
        logger: cliPlatformLog,
      },
      cliAuthProvider,
    );
    serverSideKeysInitialized = true;
  }

  await getServerSideKeyService().setUseIncludedModelAccess(false);
  await setCliHelperModel(context.helperModel);

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
