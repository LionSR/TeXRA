// Node imports
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FileSystem, Path, Stream } from 'effect';
import { afterEach, describe, expect } from 'vitest';

// Local imports
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { StorageFs } from '@platform/rootedFs';
import {
  countPinnedMemories,
  walkMemoryDirectory,
} from '@tools/memory/memoryFileSystem';
import {
  rootedFileSystem,
  type RootedFileSystem,
} from '@utils/files/rootedFileSystem';

import { nodePlatformLayer } from '../support/fsTestUtils';

const MEMORY_LISTING_CONCURRENCY = 8;
const FILE_COUNT_PER_DIRECTORY = 12;

function frontmatter(...extraFields: string[]): string {
  return [
    '---',
    'modifiedBy: test-agent',
    'modifiedAt: 2026-01-01T00:00:00.000Z',
    ...extraFields,
    '---',
    'body',
  ].join('\n');
}

const TEST_FRONTMATTER = frontmatter();
const PINNED_FRONTMATTER = frontmatter('pinned: true');

const roots: string[] = [];

/** A temp storage root with an empty memory directory under it. */
async function makeStorageRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'texra-memory-'));
  roots.push(root);
  await mkdir(path.join(root, WORKSPACE_STORAGE_LAYOUT.memory), {
    recursive: true,
  });
  return root;
}

/** The session's storage view over `root`, as `sessionFsLayer` builds it. */
const storageViewOf = (root: string): Effect.Effect<RootedFileSystem> =>
  Effect.gen(function* () {
    return rootedFileSystem(
      root,
      yield* FileSystem.FileSystem,
      yield* Path.Path,
    );
  }).pipe(Effect.provide(nodePlatformLayer));

describe('memory filesystem listing', () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it.effect(
    'bounds metadata reads while walking large memory directories',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(async () => {
          const created = await makeStorageRoot();
          for (const dir of ['alpha', 'beta']) {
            await mkdir(
              path.join(created, WORKSPACE_STORAGE_LAYOUT.memory, dir),
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
        const view = yield* storageViewOf(root);
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
      }),
  );

  it.effect(
    'stops metadata reads once the pinned-memory limit is reached',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(async () => {
          const created = await makeStorageRoot();
          const memoryDir = path.join(created, WORKSPACE_STORAGE_LAYOUT.memory);
          // A symlink back onto the tree: the walk must never descend or stat
          // it, since nothing here keeps a realpath/visited set.
          await symlink(memoryDir, path.join(memoryDir, 'cycle'));
          for (let index = 0; index < 100; index += 1) {
            await writeFile(
              path.join(memoryDir, `pinned-${index}.md`),
              PINNED_FRONTMATTER,
            );
          }
          return created;
        });

        const cyclePath = path.join(WORKSPACE_STORAGE_LAYOUT.memory, 'cycle');
        let headReads = 0;
        const view = yield* storageViewOf(root);
        const storageFs: RootedFileSystem = {
          ...view,
          stat: (target) =>
            target === cyclePath
              ? Effect.die(new Error('The symlink cycle must not be statted'))
              : view.stat(target),
          stream: (target, options) => {
            headReads += 1;
            return view.stream(target, options);
          },
        };

        const pinned = yield* countPinnedMemories(1).pipe(
          Effect.provideService(StorageFs, storageFs),
        );

        expect(pinned).toBe(1);
        expect(headReads).toBeLessThan(100);
      }),
  );

  it.effect('fails the walk with the filesystem error itself', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeStorageRoot);
      const storageFs = yield* storageViewOf(root);

      const failure = yield* Effect.flip(
        Stream.runDrain(
          walkMemoryDirectory(
            path.join(WORKSPACE_STORAGE_LAYOUT.memory, 'absent'),
          ),
        ),
      ).pipe(Effect.provideService(StorageFs, storageFs));

      expect(failure._tag).toBe('PlatformError');
      expect(failure.reason._tag).toBe('NotFound');
    }),
  );
});
