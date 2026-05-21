// Node imports
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent

// Local imports - common

// Local imports - platform
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createWorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';

// Local imports - test support
import {
  FakeConfigProvider,
  FakeSecrets,
  RecordingLogBackend,
} from '@test/support/FakePlatform';
import { GlobalStateKey } from '@common/state/stateKeys';

import { loadDesktopPlatformModule } from './loadDesktopPlatformModule.mjs';
import { loadPlatformDefaultsModule } from './loadPlatformDefaultsModule.mjs';
import type { StorageProvider } from '@platform/interfaces/storage';

interface JsonStore {
  get<T>(key: string, defaultValue?: T): T;
  snapshot(): Record<string, unknown>;
}

interface JsonStoreModule {
  JsonStore: {
    open(filePath: string): Promise<JsonStore>;
  };
}

interface JsonStateStoreModule {
  JsonStateStore: new (store: JsonStore) => {
    get<T>(key: string, defaultValue?: T): T;
    update(key: string, value: unknown): PromiseLike<void>;
  };
}

interface ElectronAgentDirectoriesModule {
  bootstrapElectronAgentDirectories(
    resourcesPath: string,
    appVersion: string | undefined,
  ): Promise<void>;
}

interface AgentDirectoriesRegistryModule {
  getAgentDirectories(): {
    builtIn(): Promise<string>;
    builtInToolUse(): Promise<string>;
  };
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

describe('desktop agent directory bootstrap', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.resetModules();
    if (tempDir == null) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  async function createHarness(): Promise<{
    bootstrapElectronAgentDirectories: ElectronAgentDirectoriesModule['bootstrapElectronAgentDirectories'];
    getAgentDirectories: AgentDirectoriesRegistryModule['getAgentDirectories'];
    globalStateStore: JsonStore;
    resourcesPath: string;
    storage: StorageProvider;
  }> {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), 'texra-electron-agents-'));
    const resourcesPath = join(tempDir, 'resources');
    const userDataPath = join(tempDir, 'userData');
    const workspacePath = join(tempDir, 'workspace');
    await Promise.all([
      writeText(join(resourcesPath, 'agents', 'writer.yaml'), 'name: writer\n'),
      writeText(
        join(resourcesPath, 'tool_use_agents', 'researcher.yaml'),
        'name: researcher\n',
      ),
      mkdir(workspacePath, { recursive: true }),
    ]);

    const [
      { JsonStore },
      { JsonStateStore },
      { bootstrapElectronAgentDirectories },
      { initPlatform },
      { getAgentDirectories },
    ] = await Promise.all([
      loadPlatformDefaultsModule<JsonStoreModule>('jsonStore.ts'),
      loadPlatformDefaultsModule<JsonStateStoreModule>('jsonStateStore.ts'),
      loadDesktopPlatformModule<ElectronAgentDirectoriesModule>(
        'agentDirectories.ts',
      ),
      import('@platform/platform'),
      import('@agent/index/agentDirectoriesRegistry'),
    ]);
    const storage = createWorkspaceStorageProvider(userDataPath, workspacePath);
    const globalStateStore = await JsonStore.open(
      join(userDataPath, 'state', 'global.json'),
    );
    const workspaceStateStore = await JsonStore.open(
      join(storage.getStoragePath(), 'state.json'),
    );

    initPlatform({
      config: new FakeConfigProvider(),
      globalState: new JsonStateStore(globalStateStore),
      workspaceState: new JsonStateStore(workspaceStateStore),
      log: new RecordingLogBackend(),
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => workspacePath),
      storage,
      secrets: new FakeSecrets(),
      lifecycle: createLifecycleHost(),
      agentResume: { tryResumeStream: async () => false },
    });

    return {
      bootstrapElectronAgentDirectories,
      getAgentDirectories,
      globalStateStore,
      resourcesPath,
      storage,
    };
  }

  it('copies bundled agents into fresh userData storage and registers directory access', async () => {
    const {
      bootstrapElectronAgentDirectories,
      getAgentDirectories,
      globalStateStore,
      resourcesPath,
      storage,
    } = await createHarness();

    await bootstrapElectronAgentDirectories(resourcesPath, '1.2.3');

    const builtInDir = await getAgentDirectories().builtIn();
    const toolUseDir = await getAgentDirectories().builtInToolUse();

    expect(builtInDir).toBe(join(storage.getGlobalStoragePath(), 'agents'));
    expect(toolUseDir).toBe(
      join(storage.getGlobalStoragePath(), 'tool_use_agents'),
    );
    await expect(
      readFile(join(builtInDir, 'writer.yaml'), 'utf8'),
    ).resolves.toBe('name: writer\n');
    await expect(
      readFile(join(toolUseDir, 'researcher.yaml'), 'utf8'),
    ).resolves.toBe('name: researcher\n');
    expect(globalStateStore.get(GlobalStateKey.LAST_KNOWN_VERSION)).toBe(
      '1.2.3',
    );
  });

  it('preserves current copied agents on same-version runs and restores missing bundled files', async () => {
    const { bootstrapElectronAgentDirectories, resourcesPath, storage } =
      await createHarness();

    await bootstrapElectronAgentDirectories(resourcesPath, '1.2.3');
    const copiedAgent = join(
      storage.getGlobalStoragePath(),
      'agents',
      'writer.yaml',
    );
    await writeFile(copiedAgent, 'name: locally-edited\n');

    await bootstrapElectronAgentDirectories(resourcesPath, '1.2.3');
    await expect(readFile(copiedAgent, 'utf8')).resolves.toBe(
      'name: locally-edited\n',
    );

    await rm(copiedAgent);
    await bootstrapElectronAgentDirectories(resourcesPath, '1.2.3');

    await expect(readFile(copiedAgent, 'utf8')).resolves.toBe('name: writer\n');
  });
});
