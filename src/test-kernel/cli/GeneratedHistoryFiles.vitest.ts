import { afterEach, describe, expect, it, vi } from 'vitest';

import { listGeneratedFiles } from '@cli/runtime/history/generatedFiles';
import { platform } from '@platform/platform';
import type { ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';

const EXECUTION_ID = 'generated-history-test' as ExecutionId;
const RUN_PATH = `/storage/executions/${EXECUTION_ID}`;

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

describe('listGeneratedFiles', () => {
  setupPlatform({
    storagePath: '/storage',
    files: {
      [`${RUN_PATH}/sub/nested.tex`]: 'nested',
      [`${RUN_PATH}/z.tex`]: 'xyz',
      [`${RUN_PATH}/vanished.tex`]: 'gone',
      [`${RUN_PATH}/blocked.tex`]: 'blocked',
      [`${RUN_PATH}/unreadable.tex`]: 'unreadable',
    },
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists generated metadata in path order and omits concurrent disappearance', async () => {
    failStatFor(
      `${RUN_PATH}/vanished.tex`,
      fsError('ENOENT', 'entry disappeared after readDir'),
    );

    await expect(listGeneratedFiles(EXECUTION_ID)).resolves.toEqual([
      { path: 'blocked.tex', size: 7, isDirectory: false },
      { path: 'sub', size: 0, isDirectory: true },
      { path: 'sub/nested.tex', size: 6, isDirectory: false },
      { path: 'unreadable.tex', size: 10, isDirectory: false },
      { path: 'z.tex', size: 3, isDirectory: false },
    ]);
  });

  it('omits an entry whose intermediate component is no longer a directory', async () => {
    failStatFor(
      `${RUN_PATH}/blocked.tex`,
      fsError('ENOTDIR', 'parent path is no longer a directory'),
    );

    const files = await listGeneratedFiles(EXECUTION_ID);

    expect(files.map((file) => file.path)).not.toContain('blocked.tex');
  });

  it('propagates operational stat failures', async () => {
    const error = fsError('EACCES', 'generated file is unreadable');
    failStatFor(`${RUN_PATH}/unreadable.tex`, error);

    await expect(listGeneratedFiles(EXECUTION_ID)).rejects.toBe(error);
  });
});
