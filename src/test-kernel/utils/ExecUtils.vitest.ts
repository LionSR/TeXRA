import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createFakePlatform } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { executeCommandSync } from '@utils/system/execUtils';

describe('executeCommandSync', () => {
  let platformStorageRoot = '';

  setupPlatform(async () => {
    platformStorageRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'texra-exec-utils-'),
    );
    return createFakePlatform(
      {
        workspacePath: process.cwd(),
        storagePath: path.join(platformStorageRoot, 'storage'),
        globalStoragePath: path.join(platformStorageRoot, 'global-storage'),
      },
      { fs: nodeFilesystem },
    );
  });

  afterEach(async () => {
    if (platformStorageRoot) {
      await fs.rm(platformStorageRoot, { recursive: true, force: true });
      platformStorageRoot = '';
    }
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
