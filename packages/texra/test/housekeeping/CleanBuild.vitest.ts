import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { collectFilesFromPatterns } from '@housekeeping/artifactFiles';
import { findBuildDirectories } from '@housekeeping/buildDirectories';
import { nodePlatformLayer, rootedFsLayer } from '@test/support/fsTestUtils';
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
          // A managed directory name compares case-insensitively.
          await mkdir(path.join(workspace, 'thesis', 'Build'), {
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

        expect(found).toEqual(['paper/build', 'thesis/Build']);
      }),
    ),
  );
});

describe('collectFilesFromPatterns', () => {
  // A folder whose name only contains "build" is not the build folder: its
  // own `build/` holds the artifacts.
  it.live('searches the build directory of a folder named like one', () =>
    withTempDirEffect('texra-artifact-files-', (workspace) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await mkdir(path.join(workspace, 'rebuild', 'build'), {
            recursive: true,
          });
          await writeFile(
            path.join(workspace, 'rebuild', 'build', 'paper.aux'),
            '',
          );
        });

        const found = yield* collectFilesFromPatterns(
          workspace,
          'rebuild',
          ['paper'],
          ['.aux'],
        ).pipe(Effect.provide(nodePlatformLayer));

        expect([...found]).toEqual(['rebuild/build/paper.aux']);
      }),
    ),
  );
});
