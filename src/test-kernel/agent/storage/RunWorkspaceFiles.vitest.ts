import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { listRunWorkspaceFiles } from '@agent/storage';
import { platform } from '@platform/platform';
import { fakePath } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { AbsoluteFS } from '@utils/files/absoluteFS';

const WORKSPACE_PATH = fakePath('workspace');
const CONFIG = { workingDirectory: WORKSPACE_PATH };

function statError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('listRunWorkspaceFiles', () => {
  setupPlatform({ workspacePath: WORKSPACE_PATH });
  afterEach(() => vi.restoreAllMocks());

  it('lists unique contained entries in path order and omits missing paths', async () => {
    await AbsoluteFS.createDir(path.join(WORKSPACE_PATH, 'z-dir'));
    await AbsoluteFS.write(path.join(WORKSPACE_PATH, 'a-file.tex'), 'content');

    await expect(
      listRunWorkspaceFiles(CONFIG, [
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
        absolutePath: path.join(WORKSPACE_PATH, 'a-file.tex'),
        size: 7,
        isDirectory: false,
      },
      {
        path: 'z-dir',
        displayPath: 'workspace/z-dir',
        absolutePath: path.join(WORKSPACE_PATH, 'z-dir'),
        // A real directory's size is the filesystem's own bookkeeping.
        size: expect.any(Number),
        isDirectory: true,
      },
    ]);
  });

  it('omits a path whose intermediate component is not a directory', async () => {
    const error = statError('ENOTDIR', 'parent path is not a directory');
    vi.spyOn(platform().fs, 'stat').mockRejectedValueOnce(error);

    await expect(
      listRunWorkspaceFiles(CONFIG, ['file/child.tex']),
    ).resolves.toEqual([]);
  });

  it('propagates operational stat failures', async () => {
    const error = statError('EACCES', 'workspace file is unreadable');
    vi.spyOn(platform().fs, 'stat').mockRejectedValueOnce(error);

    await expect(
      listRunWorkspaceFiles(CONFIG, ['unreadable.tex']),
    ).rejects.toBe(error);
  });
});
