// Node imports
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - extension
import { createExtensionTexraConfig } from '@frontend/vscode/texraConfig';

// Local imports - platform
import type { StorageProvider } from '@platform/interfaces';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

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
  const tempDirs = useTempDirs();

  async function createTempLayout(): Promise<{
    workspace: string;
    internalStorage: string;
    globalStorage: string;
  }> {
    const tempDir = await makeTempDir('texra-extension-config-', tempDirs);
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
});
