// Node imports
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - extension
import { createExtensionTexraConfig } from '@frontend/vscode/texraConfig';

// Local imports - platform
import type { StorageProvider } from '@platform/interfaces';

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

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
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
      globalValue: undefined,
      workspaceValue: undefined,
    });
    await expect(access(projectConfig)).rejects.toThrow();
    await expect(access(globalConfig)).rejects.toThrow();
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

    first.push('mutated');

    expect(config.get<string[]>(key)).not.toContain('mutated');
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

    await config.update('texra.bib.zoteroPort', 25000);
    await expect(readFile(firstConfig, 'utf8')).resolves.toContain('24001');
    await expect(readFile(secondConfig, 'utf8')).resolves.toContain('25000');
  });
});
