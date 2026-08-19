import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { platform } from '@platform/platform';
import type { ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { listRunGeneratedFiles } from '@tools/executions/runGeneratedFiles';

const EXECUTION_ID = 'generated-history-test' as ExecutionId;
const STORAGE_PATH = path.join(path.sep, 'storage');
const RUN_PATH = path.join(STORAGE_PATH, 'executions', EXECUTION_ID);

function fsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function failStatFor(targetPath: string, error: Error): void {
  const fs = platform().fs;
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
    if (candidate === targetPath) throw error;
    return stat(candidate);
  });
}

describe('listRunGeneratedFiles', () => {
  setupPlatform({
    storagePath: STORAGE_PATH,
    files: {
      [path.join(RUN_PATH, 'sub', 'nested.tex')]: 'nested',
      [path.join(RUN_PATH, 'z.tex')]: 'xyz',
      [path.join(RUN_PATH, 'vanished.tex')]: 'gone',
      [path.join(RUN_PATH, 'blocked.tex')]: 'blocked',
      [path.join(RUN_PATH, 'unreadable.tex')]: 'unreadable',
    },
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists generated metadata in path order and omits concurrent disappearance', async () => {
    failStatFor(
      path.join(RUN_PATH, 'vanished.tex'),
      fsError('ENOENT', 'entry disappeared after readDir'),
    );

    await expect(listRunGeneratedFiles(EXECUTION_ID)).resolves.toEqual([
      { path: 'blocked.tex', size: 7, isDirectory: false },
      { path: 'sub', size: 0, isDirectory: true },
      { path: 'sub/nested.tex', size: 6, isDirectory: false },
      { path: 'unreadable.tex', size: 10, isDirectory: false },
      { path: 'z.tex', size: 3, isDirectory: false },
    ]);
  });

  it('omits an entry whose intermediate component is no longer a directory', async () => {
    failStatFor(
      path.join(RUN_PATH, 'blocked.tex'),
      fsError('ENOTDIR', 'parent path is no longer a directory'),
    );

    const files = await listRunGeneratedFiles(EXECUTION_ID);

    expect(files.map((file) => file.path)).not.toContain('blocked.tex');
  });

  it('propagates operational stat failures', async () => {
    const error = fsError('EACCES', 'generated file is unreadable');
    failStatFor(path.join(RUN_PATH, 'unreadable.tex'), error);

    await expect(listRunGeneratedFiles(EXECUTION_ID)).rejects.toBe(error);
  });
});
