// Node imports
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import pDefer from 'p-defer';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - extension
import { createExtensionTexraConfig } from '@frontend/vscode/texraConfig';

// Local imports - platform
import type { StorageProvider } from '@platform/interfaces';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';

function createStorage(
  workspaceStorage: string,
  globalStorage: string,
): StorageProvider {
  return {
    getStoragePath: () => workspaceStorage,
    getGlobalStoragePath: () => globalStorage,
  };
}

describe.skipIf(process.platform === 'win32')('extension TeXRA config', () => {
  let tempDir: string | undefined;
  let readOnlyWorkspace: string | undefined;

  afterEach(async () => {
    if (readOnlyWorkspace) await chmod(readOnlyWorkspace, 0o700);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    readOnlyWorkspace = undefined;
    tempDir = undefined;
  });

  async function createTempLayout(): Promise<{
    workspace: string;
    internalStorage: string;
    globalStorage: string;
  }> {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-extension-config-'));
    const workspace = join(tempDir, 'project');
    const internalStorage = join(tempDir, 'internal');
    const globalStorage = join(tempDir, 'global');
    await Promise.all([
      mkdir(workspace),
      mkdir(internalStorage),
      mkdir(globalStorage),
    ]);
    return { workspace, internalStorage, globalStorage };
  }

  it('uses internal workspace storage when a project config cannot be created', async () => {
    const { workspace, internalStorage, globalStorage } =
      await createTempLayout();
    readOnlyWorkspace = workspace;
    await chmod(readOnlyWorkspace, 0o500);

    const config = await createExtensionTexraConfig(
      createStorage(internalStorage, globalStorage),
      readOnlyWorkspace,
    );

    await config.update('skills.enabled', false);

    await expect(
      readFile(join(internalStorage, 'config.json'), 'utf8'),
    ).resolves.toContain('"texra.skills.enabled": false');
  });

  it('returns schema defaults from an empty native config', async () => {
    const { workspace, internalStorage, globalStorage } =
      await createTempLayout();

    const projectConfig = join(workspace, '.texra', 'config.json');
    const globalConfig = join(globalStorage, 'config.json');
    await expect(access(projectConfig)).rejects.toThrow();
    await expect(access(globalConfig)).rejects.toThrow();

    const config = await createExtensionTexraConfig(
      createStorage(internalStorage, globalStorage),
      workspace,
    );

    expect(config.get('texra.bib.zoteroPort')).toBe(23119);
    expect(config.inspect('texra.bib.zoteroPort')).toStrictEqual({
      defaultValue: 23119,
      globalValue: undefined,
      workspaceValue: undefined,
    });
    await expect(access(projectConfig)).rejects.toThrow();
    await expect(access(globalConfig)).rejects.toThrow();
  });

  it('waits for workspace storage to commit before rebinding fallback config', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-extension-config-'));
    const firstWorkspace = join(tempDir, 'first');
    readOnlyWorkspace = join(tempDir, 'second');
    const storageRoot = join(tempDir, 'storage');
    await Promise.all([
      mkdir(join(firstWorkspace, '.texra'), { recursive: true }),
      mkdir(readOnlyWorkspace),
      mkdir(storageRoot),
    ]);
    await writeFile(
      join(firstWorkspace, '.texra', 'config.json'),
      '{"texra.bib.zoteroPort": 24001}\n',
    );
    await chmod(readOnlyWorkspace, 0o500);

    let workspaceRoot = firstWorkspace;
    const storage = new WorkspaceStorageProvider(
      storageRoot,
      () => workspaceRoot,
    );
    const config = await createExtensionTexraConfig(storage, workspaceRoot);

    workspaceRoot = readOnlyWorkspace;
    const continueTransition = pDefer<void>();
    const transition = config.enqueueWorkspaceTransition(
      workspaceRoot,
      async (hooks) => {
        await continueTransition.promise;
        expect(
          storage.commitWorkspaceStorageChange({
            workspacePath: workspaceRoot,
          }),
        ).toBe(true);
        await hooks.afterStorageCommit();
        storage.finalizeWorkspaceStorageChange();
        hooks.afterStorageFinalize();
      },
    );
    let updateCompleted = false;
    const update = config.update('texra.bib.zoteroPort', 25000).then(() => {
      updateCompleted = true;
    });
    await Promise.resolve();
    expect(updateCompleted).toBe(false);
    expect(config.get('texra.bib.zoteroPort')).toBe(24001);

    continueTransition.resolve();
    await transition.completion;
    const secondInternalConfig = join(storage.getStoragePath(), 'config.json');
    await update;

    await expect(readFile(secondInternalConfig, 'utf8')).resolves.toContain(
      '25000',
    );
  });

  it('returns isolated copies of mutable schema defaults', async () => {
    const { workspace, internalStorage, globalStorage } =
      await createTempLayout();

    const config = await createExtensionTexraConfig(
      createStorage(internalStorage, globalStorage),
      workspace,
    );
    const key = 'texra.latex.enabledReplacements';
    const first = config.get<string[]>(key);
    const inspection = config.inspect<string[]>(key);

    first.push('mutated');
    inspection?.defaultValue?.push('mutated-default');

    expect(config.get<string[]>(key)).not.toContain('mutated');
    expect(config.get<string[]>(key)).not.toContain('mutated-default');
    expect(inspection?.defaultValue).not.toBe(first);
  });

  it('rebinds reads and writes when the workspace folder changes', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-extension-config-'));
    const firstWorkspace = join(tempDir, 'first');
    const secondWorkspace = join(tempDir, 'second');
    const firstConfig = join(firstWorkspace, '.texra', 'config.json');
    const secondConfig = join(secondWorkspace, '.texra', 'config.json');
    const internalStorage = join(tempDir, 'internal');
    const globalStorage = join(tempDir, 'global');
    await Promise.all([
      mkdir(join(firstWorkspace, '.texra'), { recursive: true }),
      mkdir(join(secondWorkspace, '.texra'), { recursive: true }),
      mkdir(internalStorage),
      mkdir(globalStorage),
    ]);
    await Promise.all([
      writeFile(firstConfig, '{"texra.bib.zoteroPort": 24001}\n'),
      writeFile(secondConfig, '{"texra.bib.zoteroPort": 24002}\n'),
    ]);

    const config = await createExtensionTexraConfig(
      createStorage(internalStorage, globalStorage),
      firstWorkspace,
    );
    const listener = vi.fn();
    config.watch('texra.bib.zoteroPort', listener);

    expect(config.get('texra.bib.zoteroPort')).toBe(24001);
    const transition = config.enqueueWorkspaceTransition(
      secondWorkspace,
      async (hooks) => {
        await hooks.afterStorageCommit();
        hooks.afterStorageFinalize();
      },
    );
    await transition.completion;
    expect(config.get('texra.bib.zoteroPort')).toBe(24002);
    expect(listener).toHaveBeenCalledOnce();

    await config.update('texra.bib.zoteroPort', 25000);
    await expect(readFile(firstConfig, 'utf8')).resolves.toContain('24001');
    await expect(readFile(secondConfig, 'utf8')).resolves.toContain('25000');
  });
});
