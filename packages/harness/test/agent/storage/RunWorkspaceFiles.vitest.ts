import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { listRunWorkspaceFiles } from '@agent/storage/runWorkspaceFiles';
import { fakePath } from '@test/support/FakePlatform';
import { FakeHost } from '@test/support/testKernel';

const WORKSPACE_PATH = fakePath('workspace');

layer(FakeHost.layer({ workspacePath: WORKSPACE_PATH }), {
  excludeTestServices: true,
})('listRunWorkspaceFiles', (it) => {
  it.effect(
    'lists unique contained entries in path order and omits missing paths',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await mkdir(path.join(WORKSPACE_PATH, 'z-dir'), { recursive: true });
          await writeFile(path.join(WORKSPACE_PATH, 'a-file.tex'), 'content');
        });

        const files = yield* listRunWorkspaceFiles(
          { workingDirectory: WORKSPACE_PATH },
          [
            'z-dir',
            'missing.tex',
            'a-file.tex',
            'a-file.tex',
            '../outside.tex',
          ],
        );

        expect(files).toEqual([
          { path: 'a-file.tex', size: 7, isDirectory: false },
          {
            path: 'z-dir',
            // A real directory's size is the filesystem's own bookkeeping.
            size: expect.any(Number),
            isDirectory: true,
          },
        ]);
      }),
  );
});
