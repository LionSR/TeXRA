// Node imports
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FileSystem, Path, Stream } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { StorageFs } from '@platform/rootedFs';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { walkMemoryDirectory } from '@tools/memory/memoryFileSystem';
import {
  rootedFileSystem,
  type RootedFileSystem,
} from '@utils/files/rootedFileSystem';

const MEMORY_LISTING_CONCURRENCY = 8;
const FILE_COUNT_PER_DIRECTORY = 12;

const TEST_FRONTMATTER = [
  '---',
  'modifiedBy: test-agent',
  'modifiedAt: 2026-01-01T00:00:00.000Z',
  '---',
  'body',
].join('\n');

const tempDirs = useTempDirs();

describe('memory filesystem listing', () => {
  it.effect(
    'bounds metadata reads while walking large memory directories',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(async () => {
          const created = await makeTempDir('texra-memory-', tempDirs);
          for (const dir of ['alpha', 'beta']) {
            await mkdir(
              path.join(created, WORKSPACE_STORAGE_LAYOUT.memory, dir),
              { recursive: true },
            );
            for (let index = 0; index < FILE_COUNT_PER_DIRECTORY; index += 1) {
              await writeFile(
                path.join(
                  created,
                  WORKSPACE_STORAGE_LAYOUT.memory,
                  dir,
                  `note-${index}.md`,
                ),
                TEST_FRONTMATTER,
              );
            }
          }
          return created;
        });

        let activeMetadataReads = 0;
        let maxActiveMetadataReads = 0;
        // The session's storage view over `root`, as `sessionFsLayer` builds it.
        const view = rootedFileSystem(
          root,
          yield* FileSystem.FileSystem,
          yield* Path.Path,
        );
        const storageFs: RootedFileSystem = {
          ...view,
          stat: (target) =>
            Effect.gen(function* () {
              activeMetadataReads += 1;
              maxActiveMetadataReads = Math.max(
                maxActiveMetadataReads,
                activeMetadataReads,
              );
              yield* Effect.promise(() => delay(5));
              activeMetadataReads -= 1;
              return yield* view.stat(target);
            }),
        };

        const items = yield* Stream.runCollect(
          walkMemoryDirectory(WORKSPACE_STORAGE_LAYOUT.memory),
        ).pipe(Effect.provideService(StorageFs, storageFs));

        expect(items).toHaveLength(FILE_COUNT_PER_DIRECTORY * 2);
        expect(maxActiveMetadataReads).toBeGreaterThan(1);
        expect(maxActiveMetadataReads).toBeLessThanOrEqual(
          MEMORY_LISTING_CONCURRENCY,
        );
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
