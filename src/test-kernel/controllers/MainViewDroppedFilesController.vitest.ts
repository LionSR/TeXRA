import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { attachDroppedFiles } from '@texra/controllers/mainView/MainViewDroppedFilesController';

describe('MainViewDroppedFilesController', () => {
  const tempDirs = useTempDirs();

  const workspaceWith = (files: readonly string[]) =>
    Effect.promise(async () => {
      const root = await makeTempDir('texra-drop-', tempDirs);
      await mkdir(join(root, 'paper'), { recursive: true });
      for (const file of files) await writeFile(join(root, file), '');
      return root;
    });

  it.effect(
    'deduplicates accepted files while counting folders, missing and outside paths',
    () =>
      Effect.gen(function* () {
        const root = yield* workspaceWith(['paper/main.tex']);
        expect(
          yield* attachDroppedFiles(
            root,
            [
              pathToFileURL(join(root, 'paper', 'main.tex')).href,
              join(root, 'paper', 'main.tex'),
              join(root, 'paper'),
              join(root, 'paper', 'gone.tex'),
              join(root, '..', 'outside.tex'),
            ],
            ['.tex'],
          ),
        ).toEqual({
          paths: ['paper/main.tex'],
          attachedCount: 1,
          rejectedCount: 3,
        });
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
