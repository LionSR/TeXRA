import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NO_TOOL_AVAILABILITY_HOST } from '@platform/interfaces';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@platform/languageModel';
import type {
  AgentDirectoriesPort,
  StorageProvider,
} from '@platform/interfaces';
import type { JsonStore } from '@platform/defaults/jsonStore';
import type { bootstrapNodeAgentDirectories } from '@platform/defaults/nodeHost';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { nodeFileLocks } from '@platform/defaults/fileLocks';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeConfigProvider, FakeSecrets } from '@test/support/FakePlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

import { loadSourceModule } from './loadSourceModule.ts';

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

describe('desktop agent directory bootstrap', () => {
  const tempDirs = useTempDirs();

  afterEach(() => {
    vi.resetModules();
  });

  async function createHarness(): Promise<{
    bootstrapNodeAgentDirectories: typeof bootstrapNodeAgentDirectories;
    agentDirectories: AgentDirectoriesPort;
    globalStateStore: JsonStore;
    resourcesPath: string;
    storage: StorageProvider;
  }> {
    vi.resetModules();
    const tempDir = await makeTempDir('texra-electron-agents-', tempDirs);
    const resourcesPath = join(tempDir, 'resources');
    const userDataPath = join(tempDir, 'userData');
    const workspacePath = join(tempDir, 'workspace');
    await Promise.all([
      writeText(join(resourcesPath, 'agents', 'writer.yaml'), 'name: writer\n'),
      writeText(
        join(resourcesPath, 'tool_use_agents', 'researcher.yaml'),
        'name: researcher\n',
      ),
      mkdir(join(resourcesPath, 'skills'), { recursive: true }),
      mkdir(workspacePath, { recursive: true }),
    ]);

    const [
      { JsonStore },
      { bootstrapNodeAgentDirectories },
      { initPlatform, platform },
      { createPlatformAgentDirectories },
    ] = await Promise.all([
      loadSourceModule('@platform/defaults/jsonStore'),
      loadSourceModule('@platform/defaults/nodeHost'),
      import('@platform/platform'),
      import('@agent/index/platformAgentDirectories'),
    ]);
    const storage = new WorkspaceStorageProvider(userDataPath, workspacePath);
    const globalStateStore = await JsonStore.open(
      join(userDataPath, 'state', 'global.json'),
    );
    const workspaceStateStore = await JsonStore.open(
      join(storage.getStoragePath(), 'state.json'),
    );

    initPlatform({
      config: new FakeConfigProvider(),
      globalState: globalStateStore,
      workspaceState: workspaceStateStore,
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => workspacePath),
      storage,
      fileLocks: nodeFileLocks,
      secrets: new FakeSecrets(),
      lifecycle: createLifecycleHost(),
      agentResume: { tryResumeStream: async () => false },
      agentDirectories: createPlatformAgentDirectories({
        channel: 'test',
        customDirectoryStore: {
          get: () =>
            globalStateStore.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR),
        },
      }),
      languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
      toolAvailability: NO_TOOL_AVAILABILITY_HOST,
      toolMissingHandler: () => {},
    });

    return {
      bootstrapNodeAgentDirectories,
      agentDirectories: platform().agentDirectories,
      globalStateStore,
      resourcesPath,
      storage,
    };
  }

  it('copies bundled agents into fresh userData storage and registers directory access', async () => {
    const {
      agentDirectories,
      bootstrapNodeAgentDirectories,
      globalStateStore,
      resourcesPath,
      storage,
    } = await createHarness();

    await bootstrapNodeAgentDirectories({
      channel: 'desktop',
      resourcesPath,
      currentVersion: '1.2.3',
      versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
    });

    const builtInDir = await agentDirectories.builtIn();
    const toolUseDir = await agentDirectories.builtInToolUse();

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

  it('skips same-resource re-entry but refreshes when the resource path changes', async () => {
    const { bootstrapNodeAgentDirectories, resourcesPath, storage } =
      await createHarness();

    await bootstrapNodeAgentDirectories({
      channel: 'desktop',
      resourcesPath,
      currentVersion: '1.2.3',
      versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
    });
    const copiedAgent = join(
      storage.getGlobalStoragePath(),
      'agents',
      'writer.yaml',
    );
    await writeFile(copiedAgent, 'name: locally-edited\n');

    await bootstrapNodeAgentDirectories({
      channel: 'desktop',
      resourcesPath,
      currentVersion: '1.2.3',
      versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
    });
    await expect(readFile(copiedAgent, 'utf8')).resolves.toBe(
      'name: locally-edited\n',
    );

    const nextResourcesPath = join(dirname(resourcesPath), 'resources-next');
    await writeText(
      join(nextResourcesPath, 'agents', 'writer.yaml'),
      'name: next\n',
    );
    await writeText(
      join(nextResourcesPath, 'tool_use_agents', 'researcher.yaml'),
      'name: researcher\n',
    );

    await bootstrapNodeAgentDirectories({
      channel: 'desktop',
      resourcesPath: nextResourcesPath,
      currentVersion: '1.2.4',
      versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
    });
    await expect(readFile(copiedAgent, 'utf8')).resolves.toBe('name: next\n');
  });

  it('uses the configured version-state key', async () => {
    const { bootstrapNodeAgentDirectories, globalStateStore, resourcesPath } =
      await createHarness();

    await bootstrapNodeAgentDirectories({
      channel: 'cli',
      resourcesPath,
      currentVersion: '2.0.0',
      versionStateKey: GlobalStateKey.CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION,
    });

    expect(
      globalStateStore.get(
        GlobalStateKey.CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION,
      ),
    ).toBe('2.0.0');
    expect(
      globalStateStore.get(GlobalStateKey.LAST_KNOWN_VERSION),
    ).toBeUndefined();
  });

  it('registers runtime skills through the shared Node host defaults', async () => {
    const { resourcesPath } = await createHarness();
    const { initializeNodeRuntimeSkills } = await loadSourceModule(
      '@platform/defaults/nodeHost',
    );
    const { listRuntimeSkillSources } = await import('@skills/runtimeSkills');

    initializeNodeRuntimeSkills({
      cwd: resolve(sep, 'tmp', 'project'),
      resourcesPath,
      skillSourceOptions: {
        includeInterop: true,
        additionalPaths: ['vendor/skills'],
      },
    });

    const sources = listRuntimeSkillSources();
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'custom',
          path: resolve(sep, 'tmp', 'project', 'vendor', 'skills'),
          required: true,
        }),
        expect.objectContaining({
          scope: 'project',
          path: resolve(sep, 'tmp', 'project', '.texra', 'skills'),
        }),
        expect.objectContaining({
          scope: 'interop',
          path: resolve(sep, 'tmp', 'project', '.codex', 'skills'),
        }),
        expect.objectContaining({
          scope: 'bundled',
          path: join(resourcesPath, 'skills'),
        }),
      ]),
    );
  });
});
