// Node imports
import { chmod, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - extension
import { createExtensionTexraConfig } from '@frontend/vscode/texraConfig';

// Local imports - platform
import type { StorageProvider } from '@platform/interfaces';

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

    const storage: StorageProvider = {
      getStoragePath: () => internalStorage,
      getGlobalStoragePath: () => globalStorage,
    };
    const config = await createExtensionTexraConfig(storage, readOnlyWorkspace);

    await config.update('skills.enabled', false);

    await expect(
      readFile(join(internalStorage, 'config.json'), 'utf8'),
    ).resolves.toContain('"texra.skills.enabled": false');
  });
});
