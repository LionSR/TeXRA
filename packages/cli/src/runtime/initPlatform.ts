// Local imports - platform
import { createMemoryStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { initPlatform, tryPlatform } from '@platform/platform';

// Local imports - agent index
import { bootstrapPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';

// Local imports - auth
import {
  getServerSideKeyService,
  initializeServerSideKeyAccess,
} from '@auth/serverKeys';

// Local imports - common state
import { GlobalStateKey } from '@common/state/stateKeys';

// Local imports - logger
import { setOutputChannelFactory } from '@logger/logUtils';

// Local imports - CLI runtime
import { getCliSecrets } from './cliSecrets';
import { writeTextStderr } from './logSinks';
import { MemoryConfigProvider } from './memoryStores';
import { getCliAuthProvider, initializeCliSupabaseAuth } from './supabaseAuth';

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

function logAt(
  level: 'debug' | 'info' | 'warn',
  channel: string,
  message: string,
): void {
  if (quietPlatformLogs) return;
  writeTextStderr(`[${level}] [${channel}] ${message}`);
}

const cliPlatformLog: LogBackend = {
  initialize() {},
  debug: (channel, message) => logAt('debug', channel, message),
  info: (channel, message) => logAt('info', channel, message),
  warn: (channel, message) => logAt('warn', channel, message),
  error: (channel, message) =>
    writeTextStderr(`[error] [${channel}] ${message}`),
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
    'apiMode' | 'cwd' | 'resourcesPath' | 'helperModel' | 'quietLogs'
  > & { skipIncludedModelAccess?: boolean },
): Promise<void> {
  cliWorkspaceCwd = context.cwd;
  quietPlatformLogs = context.quietLogs ?? false;
  setOutputChannelFactory(
    quietPlatformLogs ? () => ({ appendLine: () => undefined }) : null,
  );

  if (!tryPlatform()) {
    initPlatform({
      config: new MemoryConfigProvider(),
      globalState: createMemoryStore(),
      workspaceState: createMemoryStore(),
      log: cliPlatformLog,
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => cliWorkspaceCwd),
      storage: createNodeStorageProvider({
        workspacePath: () => cliWorkspaceCwd,
      }),
      secrets: getCliSecrets(),
      lifecycle: noopLifecycle,
      agentResume: { tryResumeStream: async () => false },
    });
  }

  if (!serverSideKeysInitialized) {
    initializeCliSupabaseAuth(cliPlatformLog);
    initializeServerSideKeyAccess(
      { state: tryPlatform()?.globalState, logger: cliPlatformLog },
      getCliAuthProvider(),
    );
    serverSideKeysInitialized = true;
  }

  const forcePersonalApiKeys =
    context.skipIncludedModelAccess === true || context.apiMode === 'personal';
  const authed = forcePersonalApiKeys
    ? false
    : await getCliAuthProvider().isAuthenticated();
  await getServerSideKeyService().setUseIncludedModelAccess(authed);
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
