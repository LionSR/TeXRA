// Node imports
import * as path from 'node:path';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, type FileSystem, Option } from 'effect';
import { expect } from 'vitest';

// Local imports
import { StorageFs, type RootedFileSystem } from '@texra-ai/harness/plugins';
import { MEMORY_DISPLAY_ROOT } from '@agent/memory/memoryLayout';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { outputOf } from '@test/support/toolResultFields';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { seedEditedFiles } from '@test/support/runRecordSeeds';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { isolatedTestSession, SessionGraph } from '@test/support/testKernel';
import { MemoryTool } from '@tools/memory/MemoryTool';

const TEST_TIMESTAMP = Date.parse('2026-01-01T00:00:00.000Z');

/** One `stat` answer of the session's storage view. */
function entryInfo(
  type: FileSystem.File.Type,
  size: number,
): FileSystem.File.Info {
  // cast: the memory tree reads only the type, mtime and size of a stat.
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
  // cast: a case supplies every operation the memory tree calls on its path.
  return view as RootedFileSystem;
}

function viewMemory(storageFs: RootedFileSystem, memoryPath?: string) {
  return MemoryTool.call({ command: 'view', path: memoryPath }).pipe(
    Effect.provideService(StorageFs, storageFs),
    Effect.provide(nativeToolTestLayer()),
  );
}

layer(SessionGraph.hosted)('MemoryTool view with an omitted path', (it) => {
  it.effect(
    'lists the empty memory root instead of erroring on a fresh session',
    () =>
      Effect.gen(function* () {
        const storageFs = storageView({ exists: () => Effect.succeed(false) });

        const omitted = yield* viewMemory(storageFs);
        const explicitRoot = yield* viewMemory(storageFs, MEMORY_DISPLAY_ROOT);

        expect(omitted).toEqual(explicitRoot);
        expect(omitted.status).toBe('executed');
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

      expect(result.status).toBe('executed');
      expect(outputOf(result)).not.toContain('cycle');
    }),
  );
});

layer(SessionGraph.hosted)('MemoryTool line numbers', (it) => {
  it.effect('insert accepts exactly the lines a view numbered', () =>
    Effect.gen(function* () {
      const notePath = `${MEMORY_DISPLAY_ROOT}/note.md`;
      const written: string[] = [];
      const storageFs = storageView({
        root: '/storage',
        exists: () => Effect.succeed(true),
        stat: () => Effect.succeed(entryInfo('File', 4)),
        readFile: () => Effect.succeed(Buffer.from('a\nb\n', 'utf-8')),
        writeFileAtomic: (_target, bytes) =>
          Effect.sync(() => {
            written.push(Buffer.from(bytes).toString('utf-8'));
          }),
      });
      const session = yield* isolatedTestSession();
      const runId = yield* publishTestRunStart(session);
      yield* seedEditedFiles(session, runId, [notePath]);
      const call = (input: Parameters<typeof MemoryTool.call>[0]) =>
        MemoryTool.call(input).pipe(
          Effect.provideService(StorageFs, storageFs),
          Effect.provide(
            nativeToolTestLayer({ run: { runId, toolPolicy: {}, session } }),
          ),
        );
      const insertAt = (insert_line: number) =>
        call({
          command: 'insert',
          path: notePath,
          insert_line,
          insert_text: 'c',
        });

      // The view numbers two lines: the newline that ends the file is not a
      // third.
      const viewed = yield* call({ command: 'view', path: notePath });
      expect(outputOf(viewed)).toMatch(/2\D+b$/);

      const pastTheEnd = yield* insertAt(3);
      expect(pastTheEnd).toMatchObject({
        status: 'error',
        error: expect.stringContaining('[0, 2]'),
      });

      const appended = yield* insertAt(2);
      expect(appended.status).toBe('executed');
      expect(
        written.map((file) => file.replace(/^---\n[^]*?---\n/, '')),
      ).toEqual(['a\nb\nc\n']);
    }),
  );
});
