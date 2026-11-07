import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { listRunWorkspaceFiles } from '@agent/storage/runWorkspaceFiles';
import { FakeHost } from '@test/support/testKernel';

layer(FakeHost.layer(), {
  excludeTestServices: true,
})('listRunWorkspaceFiles', (it) => {
  it.effect(
    'lists unique contained entries in path order and omits missing paths',
    () =>
      Effect.gen(function* () {
        const workspaceRoot = (yield* FakeHost).path('workspace');
        yield* Effect.promise(async () => {
          await mkdir(path.join(workspaceRoot, 'z-dir'), { recursive: true });
          await writeFile(path.join(workspaceRoot, 'a-file.tex'), 'content');
        });

        const files = yield* listRunWorkspaceFiles(
          { workingDirectory: workspaceRoot },
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
