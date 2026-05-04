// Node imports
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - agent

// Local imports - common

// Local imports - platform
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';

// Local imports - test support
import {
  FakeConfigProvider,
  FakeSecrets,
  RecordingLogBackend,
} from '@test/support/FakePlatform';
import { getAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import { GlobalStateKey } from '@common/state/stateKeys';

import { loadDesktopPlatformModule } from './loadDesktopPlatformModule';

interface JsonStore {
  get<T>(key: string, defaultValue?: T): T;
  snapshot(): Record<string, unknown>;
}

interface JsonStoreModule {
  JsonStore: {
    open(filePath: string): Promise<JsonStore>;
  };
}

interface ElectronStateStoreModule {
  ElectronStateStore: new (store: JsonStore) => {
    get<T>(key: string, defaultValue?: T): T;
    update(key: string, value: unknown): PromiseLike<void>;
  };
}

interface ElectronStorageProvider {
  getGlobalStoragePath(): string;
  getStoragePath(): string;
}

interface ElectronStorageModule {
  ElectronStorageProvider: new (
    userDataPath: string,
    workspacePath: string | undefined,
  ) => ElectronStorageProvider;
}

interface ElectronAgentDirectoriesModule {
  bootstrapElectronAgentDirectories(
    resourcesPath: string,
    appVersion: string | undefined,
  ): Promise<void>;
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

describe('desktop agent directory bootstrap', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir == null) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  async function createHarness(): Promise<{
    bootstrapElectronAgentDirectories: ElectronAgentDirectoriesModule['bootstrapElectronAgentDirectories'];
    globalStateStore: JsonStore;
    resourcesPath: string;
    storage: ElectronStorageProvider;
  }> {
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
      { ElectronStateStore },
      { ElectronStorageProvider },
      { bootstrapElectronAgentDirectories },
      { initPlatform },
    ] = await Promise.all([
      loadDesktopPlatformModule<JsonStoreModule>('jsonStore.ts'),
      loadDesktopPlatformModule<ElectronStateStoreModule>('electronState.ts'),
      loadDesktopPlatformModule<ElectronStorageModule>('electronStorage.ts'),
      loadDesktopPlatformModule<ElectronAgentDirectoriesModule>(
        'agentDirectories.ts',
      ),
      import('@platform/platform'),
    ]);
    const globalStateStore = await JsonStore.open(
      join(userDataPath, 'state', 'global.json'),
    );
    const workspaceStateStore = await JsonStore.open(
      join(userDataPath, 'state', 'workspace.json'),
    );
    const storage = new ElectronStorageProvider(userDataPath, workspacePath);

    initPlatform({
      config: new FakeConfigProvider(),
      globalState: new ElectronStateStore(globalStateStore),
      workspaceState: new ElectronStateStore(workspaceStateStore),
      log: new RecordingLogBackend(),
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => workspacePath),
      storage,
      secrets: new FakeSecrets(),
    });

    return {
      bootstrapElectronAgentDirectories,
      globalStateStore,
      resourcesPath,
      storage,
    };
  }

  it('copies bundled agents into fresh userData storage and registers directory access', async () => {
    const {
      bootstrapElectronAgentDirectories,
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
