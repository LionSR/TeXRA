import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { findBuildDirectories } from '@housekeeping/clean';
import { rootedFsLayer } from '@test/support/fsTestUtils';
import { withTempDirEffect } from '@test/support/tempDirPlatform';

describe('findBuildDirectories', () => {
  it.live('lists build directories and never a plain file named build', () =>
    withTempDirEffect('texra-clean-build-', (workspace) =>
      Effect.gen(function* () {
        // A plain file named `build` (a build script) must never reach the
        // recursive removal; a real `build/` directory must.
        yield* Effect.promise(async () => {
          await writeFile(path.join(workspace, 'build'), '#!/bin/sh\n');
          await mkdir(path.join(workspace, 'paper', 'build'), {
            recursive: true,
          });
        });

        const found = yield* findBuildDirectories.pipe(
          Effect.provide(
            rootedFsLayer({
              workspace,
              storage: path.join(workspace, '.texra'),
              globalStorage: path.join(workspace, '.global'),
            }),
          ),
        );

        expect(found).toEqual(['paper/build']);
      }),
    ),
  );
});
