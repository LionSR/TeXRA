import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listExecutionWorkspaceFiles } from '@agent/storage';
import { platform } from '@platform/platform';
import { setupPlatform } from '@test/support/setupPlatform';
import { AbsoluteFS } from '@utils/files';

const CONFIG = { workingDirectory: '/workspace' };

function statError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('listExecutionWorkspaceFiles', () => {
  setupPlatform({ workspacePath: '/workspace' });
  afterEach(() => vi.restoreAllMocks());

  it('lists unique contained entries in path order and omits missing paths', async () => {
    await AbsoluteFS.createDir('/workspace/z-dir');
    await AbsoluteFS.write('/workspace/a-file.tex', 'content');

    await expect(
      listExecutionWorkspaceFiles(CONFIG, [
        'z-dir',
        'missing.tex',
        'a-file.tex',
        'a-file.tex',
        '../outside.tex',
      ]),
    ).resolves.toEqual([
      {
        path: 'a-file.tex',
        displayPath: 'workspace/a-file.tex',
        absolutePath: '/workspace/a-file.tex',
        size: 7,
        isDirectory: false,
      },
      {
        path: 'z-dir',
        displayPath: 'workspace/z-dir',
        absolutePath: '/workspace/z-dir',
        size: 0,
        isDirectory: true,
      },
    ]);
  });

  it('omits a path whose intermediate component is not a directory', async () => {
    const error = statError('ENOTDIR', 'parent path is not a directory');
    vi.spyOn(platform().fs, 'stat').mockRejectedValueOnce(error);

    await expect(
      listExecutionWorkspaceFiles(CONFIG, ['file/child.tex']),
    ).resolves.toEqual([]);
  });

  it('propagates operational stat failures', async () => {
    const error = statError('EACCES', 'workspace file is unreadable');
    vi.spyOn(platform().fs, 'stat').mockRejectedValueOnce(error);

    await expect(
      listExecutionWorkspaceFiles(CONFIG, ['unreadable.tex']),
    ).rejects.toBe(error);
  });
});
