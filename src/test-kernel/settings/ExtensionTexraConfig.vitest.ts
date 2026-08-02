// Node imports
import {
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
  let readOnlyWorkspace: string | undefined;

  afterEach(async () => {
    if (readOnlyWorkspace) await chmod(readOnlyWorkspace, 0o700);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    readOnlyWorkspace = undefined;
    tempDir = undefined;
  });

  it('uses internal workspace storage when a project config cannot be created', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-extension-config-'));
    readOnlyWorkspace = join(tempDir, 'project');
    const internalStorage = join(tempDir, 'internal');
    const globalStorage = join(tempDir, 'global');
    await Promise.all([
      mkdir(readOnlyWorkspace),
      mkdir(internalStorage),
      mkdir(globalStorage),
    ]);
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
    tempDir = await mkdtemp(join(tmpdir(), 'texra-extension-config-'));
    const workspace = join(tempDir, 'project');
    const internalStorage = join(tempDir, 'internal');
    const globalStorage = join(tempDir, 'global');
    await Promise.all([
      mkdir(workspace),
      mkdir(internalStorage),
      mkdir(globalStorage),
    ]);

    const config = await createExtensionTexraConfig(
      createStorage(internalStorage, globalStorage),
      workspace,
    );

    expect(config.get('texra.bib.zoteroPort')).toBe(23119);
    expect(config.inspect('texra.bib.zoteroPort')).toStrictEqual({
      defaultValue: 23119,
      globalValue: undefined,
      workspaceValue: undefined,
      effectiveValue: 23119,
    });
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
    await config.rebindWorkspace(secondWorkspace);
    expect(config.get('texra.bib.zoteroPort')).toBe(24002);
    expect(listener).toHaveBeenCalledOnce();

    await config.update('texra.bib.zoteroPort', 25000);
    await expect(readFile(firstConfig, 'utf8')).resolves.toContain('24001');
    await expect(readFile(secondConfig, 'utf8')).resolves.toContain('25000');
  });
});
