import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeCommandSync } from '@utils/system/execUtils';

async function initDefaultFakePlatform(): Promise<void> {
  const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/FakePlatform'),
  ]);
  initPlatform(createFakePlatform());
}

async function initNodeBackedPlatform(options: {
  storagePath: string;
  globalStoragePath: string;
}): Promise<void> {
  const [{ initPlatform }, { nodeFilesystem }, { createFakePlatform }] =
    await Promise.all([
      import('@platform/platform'),
      import('@platform/defaults/nodeFilesystem'),
      import('@test/support/FakePlatform'),
    ]);
  initPlatform(
    createFakePlatform(
      {
        workspacePath: process.cwd(),
        storagePath: options.storagePath,
        globalStoragePath: options.globalStoragePath,
      },
      { fs: nodeFilesystem },
    ),
  );
}

describe('executeCommandSync', () => {
  let platformStorageRoot = '';

  beforeEach(async () => {
    platformStorageRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'texra-exec-utils-'),
    );
    await initNodeBackedPlatform({
      storagePath: path.join(platformStorageRoot, 'storage'),
      globalStoragePath: path.join(platformStorageRoot, 'global-storage'),
    });
  });

  afterEach(async () => {
    if (platformStorageRoot) {
      await fs.rm(platformStorageRoot, { recursive: true, force: true });
      platformStorageRoot = '';
    }
    await initDefaultFakePlatform();
  });

  it('returns normalized stdout for successful commands', () => {
    const result = executeCommandSync([
      process.execPath,
      '-e',
      'process.stdout.write("ok\\n")',
    ]);

    expect(result).toMatchObject({
      success: true,
      stdout: 'ok',
      stderr: null,
      timedOut: false,
      exitCode: 0,
    });
  });

  it('returns stderr and exit code for failing commands', () => {
    const result = executeCommandSync([
      process.execPath,
      '-e',
      'process.stderr.write("bad\\n"); process.exit(7)',
    ]);

    expect(result).toMatchObject({
      success: false,
      stdout: null,
      stderr: 'bad',
      timedOut: false,
      exitCode: 7,
    });
  });
});
