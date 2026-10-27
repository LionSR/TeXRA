// Node imports
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, type FileSystem, Option } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { StorageFs } from '@platform/rootedFs';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { MEMORY_DISPLAY_ROOT } from '@tools/memory/memoryUtils';
import { MemoryTool } from '@tools/memory/MemoryTool';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';

const TEST_TIMESTAMP = Date.parse('2026-01-01T00:00:00.000Z');

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

  it.effect('skips a symlink cycle when listing memory directories', () =>
    Effect.gen(function* () {
      const cyclePath = path.posix.join(
        WORKSPACE_STORAGE_LAYOUT.memory,
        'cycle',
      );

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
