import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { listRunWorkspaceFiles } from '@agent/storage';
import { fakePath } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';

const WORKSPACE_PATH = fakePath('workspace');
const CONFIG = { workingDirectory: WORKSPACE_PATH };

const list = (paths: string[]): Promise<unknown> =>
  Effect.runPromise(listRunWorkspaceFiles(CONFIG, paths));

describe('listRunWorkspaceFiles', () => {
  setupPlatform({ workspacePath: WORKSPACE_PATH });

  it('lists unique contained entries in path order and omits missing paths', async () => {
    await mkdir(path.join(WORKSPACE_PATH, 'z-dir'), { recursive: true });
    await writeFile(path.join(WORKSPACE_PATH, 'a-file.tex'), 'content');

    await expect(
      list([
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
    await mkdir(WORKSPACE_PATH, { recursive: true });
    await writeFile(path.join(WORKSPACE_PATH, 'not-a-dir.tex'), 'content');

    await expect(list(['not-a-dir.tex/child.tex'])).resolves.toEqual([]);
  });

  it('propagates operational stat failures', async () => {
    // A component past the filesystem's name limit fails ENAMETOOLONG, which
    // is neither absence nor a non-directory parent, so it must surface.
    await expect(list([`${'x'.repeat(5000)}.tex`])).rejects.toThrow();
  });
});
