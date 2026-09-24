// Node imports
import { Buffer } from 'node:buffer';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, type FileSystem, Option, Stream } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { StorageFs } from '@platform/rootedFs';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { MEMORY_DISPLAY_ROOT } from '@tools/memory/constants';
import { MemoryTool } from '@tools/memory/MemoryTool';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';

const TEST_TIMESTAMP = Date.parse('2026-01-01T00:00:00.000Z');
const TEST_FRONTMATTER = [
  '---',
  'modifiedBy: test-agent',
  'modifiedAt: 2026-01-01T00:00:00.000Z',
  '---',
  'note body',
].join('\n');
const PINNED_FRONTMATTER = [
  '---',
  'modifiedBy: pin-agent',
  'modifiedAt: 2026-01-01T00:00:00.000Z',
  'runId: run-7',
  'pinned: true',
  '---',
  'pinned body',
].join('\n');

/** One `stat` answer of the session's storage view. */
function entryInfo(
  type: FileSystem.File.Type,
  size: number,
): FileSystem.File.Info {
  return {
    type,
    mtime: Option.some(new Date(TEST_TIMESTAMP)),
    size: BigInt(size),
  } as unknown as FileSystem.File.Info;
}

/**
 * The session's storage view with only the operations the memory tree calls.
 * The view captures its root when it is built, so a case names the paths it
 * answers relative to that root, as the tool now does.
 */
function storageView(view: Partial<RootedFileSystem>): RootedFileSystem {
  return view as RootedFileSystem;
}

function viewMemory(storageFs: RootedFileSystem, memoryPath?: string) {
  return MemoryTool.call({ command: 'view', path: memoryPath }).pipe(
    Effect.provideService(StorageFs, storageFs),
    Effect.provide(nativeToolTestLayer()),
  );
}

describe('MemoryTool view with an omitted path', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.effect(
    'lists the empty memory root instead of erroring on a fresh session',
    () =>
      Effect.gen(function* () {
        const storageFs = storageView({ exists: () => Effect.succeed(false) });

        const omitted = yield* viewMemory(storageFs);
        const explicitRoot = yield* viewMemory(storageFs, MEMORY_DISPLAY_ROOT);

        expect(omitted).toEqual(explicitRoot);
        expect(omitted).toMatchObject({
          status: 'executed',
          summary: 'Viewed empty memory directory',
        });
      }),
  );

  it.effect.each([
    [
      '/outside.md',
      'Invalid path "/outside.md". All memory paths must start with /memories',
    ],
    ['/memories/../outside.md', 'Invalid memory path: /memories/../outside.md'],
  ])('preserves the path validator error for %s', ([inputPath, message]) =>
    Effect.gen(function* () {
      const result = yield* viewMemory(storageView({}), inputPath);

      expect(result).toMatchObject({
        status: 'error',
        error: expect.stringContaining(message),
        diagnostics: { name: 'ToolError' },
      });
    }),
  );

  it.effect(
    'preserves the model-facing directory listing bytes and depth limit',
    () =>
      Effect.gen(function* () {
        // Only the system clock is pinned (the MODIFIED column is relative to
        // now); the walk runs on Effect's scheduler, which needs live
        // setImmediate/setTimeout to make progress.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));

        const alphaPath = path.join(WORKSPACE_STORAGE_LAYOUT.memory, 'alpha');
        const betaPath = path.join(alphaPath, 'beta');
        const pinnedPath = path.join(alphaPath, 'pinned.md');
        const rootFilePath = path.join(
          WORKSPACE_STORAGE_LAYOUT.memory,
          'root.md',
        );

        const storageFs = storageView({
          exists: () => Effect.succeed(true),
          readDirectoryTyped: (target) => {
            if (target === WORKSPACE_STORAGE_LAYOUT.memory) {
              return Effect.succeed([
                ['alpha', 'Directory'],
                ['root.md', 'File'],
              ] as const);
            }
            if (target === alphaPath) {
              return Effect.succeed([
                ['pinned.md', 'File'],
                ['beta', 'Directory'],
              ] as const);
            }
            if (target === betaPath) {
              return Effect.die(
                new Error('The depth-2 directory must not be traversed'),
              );
            }
            return Effect.die(
              new Error(`Unexpected listing target: ${target}`),
            );
          },
          stat: (target) => {
            if (target === pinnedPath) {
              return Effect.succeed(
                entryInfo('File', Buffer.byteLength(PINNED_FRONTMATTER)),
              );
            }
            if (target === rootFilePath) {
              return Effect.succeed(
                entryInfo('File', Buffer.byteLength(TEST_FRONTMATTER)),
              );
            }
            return Effect.succeed(entryInfo('Directory', 0));
          },
          stream: (target) =>
            Stream.make(
              Buffer.from(
                target === pinnedPath ? PINNED_FRONTMATTER : TEST_FRONTMATTER,
              ),
            ),
        });

        const result = yield* viewMemory(storageFs, MEMORY_DISPLAY_ROOT);

        expect(result).toEqual({
          status: 'executed',
          summary: 'Listed directory: /memories (1–5 of 5)',
          output: [
            'Contents of /memories (showing 1–5 of 5, up to 2 levels deep):',
            'SIZE\tMODIFIED\tBY\tPATH',
            '0 B\tyesterday\t-\t/memories',
            '0 B\tyesterday\t-\t/memories/alpha',
            `${Buffer.byteLength(PINNED_FRONTMATTER)} B\tyesterday\tpin-agent (run-7)\t/memories/alpha/pinned.md [pinned]`,
            '0 B\tyesterday\t-\t/memories/alpha/beta',
            `${Buffer.byteLength(TEST_FRONTMATTER)} B\tyesterday\ttest-agent\t/memories/root.md`,
          ].join('\n'),
        });
      }),
  );

  it.effect('skips a symlink cycle when listing memory directories', () =>
    Effect.gen(function* () {
      const cyclePath = path.join(WORKSPACE_STORAGE_LAYOUT.memory, 'cycle');

      const storageFs = storageView({
        exists: () => Effect.succeed(true),
        readDirectoryTyped: (target) => {
          if (target === WORKSPACE_STORAGE_LAYOUT.memory) {
            return Effect.succeed([['cycle', 'SymbolicLink']] as const);
          }
          return Effect.die(
            new Error('The symlink cycle must not be traversed'),
          );
        },
        stat: (target) => {
          if (target === cyclePath) {
            return Effect.die(
              new Error('The symlink cycle must not be statted'),
            );
          }
          return Effect.succeed(entryInfo('Directory', 0));
        },
      });

      const result = yield* viewMemory(storageFs, MEMORY_DISPLAY_ROOT);

      expect(result).toMatchObject({
        status: 'executed',
        summary: 'Listed directory: /memories (1–1 of 1)',
      });
      expect(result.output).not.toContain('cycle');
    }),
  );
});

describe('MemoryTool invocation storage root', () => {
  afterEach(() => vi.restoreAllMocks());

  it.effect(
    'writes through the view its call was given, not an ambient root',
    () =>
      Effect.gen(function* () {
        const first = createFakeWorkspaceRoots({ storagePath: '/storage/one' });
        const second = createFakeWorkspaceRoots({
          storagePath: '/storage/two',
        });
        const writes: string[] = [];
        const viewOf = (root: string): RootedFileSystem =>
          storageView({
            root,
            exists: () => Effect.succeed(false),
            makeDirectory: () => Effect.void,
            writeFileAtomic: (target) =>
              Effect.sync(() => {
                writes.push(path.resolve(root, target));
              }),
          });

        yield* Effect.forEach(
          [
            [first, 'one.md'],
            [second, 'two.md'],
          ] as const,
          ([roots, file], index) =>
            MemoryTool.call({
              command: 'create',
              path: `/memories/${file}`,
              file_text: file,
            }).pipe(
              Effect.provideService(StorageFs, viewOf(roots.storage)),
              Effect.provide(
                nativeToolTestLayer({
                  roots,
                }),
              ),
            ),
          { concurrency: 'unbounded' },
        );

        expect(writes.toSorted()).toEqual(
          [
            path.resolve(first.storage, 'memories/one.md'),
            path.resolve(second.storage, 'memories/two.md'),
          ].toSorted(),
        );
      }),
  );
});
