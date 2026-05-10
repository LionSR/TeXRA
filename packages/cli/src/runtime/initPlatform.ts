// Local imports - agent index
import { bootstrapPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';

// Local imports - platform
import { initPlatform, tryPlatform } from '@platform/platform';
import { consoleLog } from '@platform/defaults/consoleLog';
import { EnvSecrets } from '@platform/defaults/envSecrets';
import { createMemoryStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { nodeStorage } from '@platform/defaults/nodeStorage';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import type { LifecycleHost } from '@platform/interfaces/lifecycle';

// Local imports - CLI runtime
import type { CliContext } from './cliContext';
import { MemoryConfigProvider } from './memoryStores';

const noopLifecycle: LifecycleHost = {
  onShutdown: () => ({ dispose: () => {} }),
  async runShutdown() {},
};

export async function initCliPlatform(
  context: Pick<CliContext, 'cwd' | 'resourcesPath'>,
): Promise<void> {
  if (!tryPlatform()) {
    initPlatform({
      config: new MemoryConfigProvider(),
      globalState: createMemoryStore(),
      workspaceState: createMemoryStore(),
      log: consoleLog,
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => context.cwd),
      storage: nodeStorage,
      secrets: new EnvSecrets(),
      lifecycle: noopLifecycle,
    });
  }

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
}
