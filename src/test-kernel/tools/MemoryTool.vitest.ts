// Node imports
import { Buffer } from 'node:buffer';
import * as path from 'node:path';
import { Readable } from 'node:stream';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import { FileType, type FileStat } from '@platform/interfaces';
import { MEMORY_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import {
  processWorkspaceRoots,
  runWithWorkspaceRoots,
} from '@platform/workspaceRoots';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { MEMORY_DISPLAY_ROOT } from '@tools/memory/constants';
import { MemoryTool } from '@tools/memory/MemoryTool';
import { AbsoluteFS } from '@utils/files/absoluteFS';

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

function dirStat(): FileStat {
  return {
    type: FileType.Directory,
    ctime: TEST_TIMESTAMP,
    mtime: TEST_TIMESTAMP,
    size: 0,
  };
}

function fileStat(size: number): FileStat {
  return {
    type: FileType.File,
    ctime: TEST_TIMESTAMP,
    mtime: TEST_TIMESTAMP,
    size,
  };
}

function runOfEvent(
  content: string,
): ReturnType<typeof AbsoluteFS.createReadStream> {
  return Readable.from([Buffer.from(content)]) as unknown as ReturnType<
    typeof AbsoluteFS.createReadStream
  >;
}

function memoryRoot(): string {
  return path.resolve(processWorkspaceRoots().storage, MEMORY_STORAGE_DIR);
}

function viewMemory(path?: string) {
  return new MemoryTool()
    .call({ command: 'view', path })
    .pipe(Effect.provide(nativeToolTestLayer()));
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
        vi.spyOn(AbsoluteFS, 'exists').mockResolvedValue(false);

        const omitted = yield* viewMemory();
        const explicitRoot = yield* viewMemory(MEMORY_DISPLAY_ROOT);

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
      const result = yield* viewMemory(inputPath);

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

        const rootPath = memoryRoot();
        const alphaPath = path.join(rootPath, 'alpha');
        const betaPath = path.join(alphaPath, 'beta');
        const pinnedPath = path.join(alphaPath, 'pinned.md');
        const rootFilePath = path.join(rootPath, 'root.md');

        vi.spyOn(AbsoluteFS, 'exists').mockResolvedValue(true);
        vi.spyOn(AbsoluteFS, 'readDir').mockImplementation(async (target) => {
          if (target === rootPath) {
            return [
              ['alpha', FileType.Directory],
              ['root.md', FileType.File],
            ];
          }
          if (target === alphaPath) {
            return [
              ['pinned.md', FileType.File],
              ['beta', FileType.Directory],
            ];
          }
          if (target === betaPath) {
            throw new Error('The depth-2 directory must not be traversed');
          }
          throw new Error(`Unexpected readDir target: ${target}`);
        });
        vi.spyOn(AbsoluteFS, 'stat').mockImplementation(async (target) => {
          if (target === pinnedPath) {
            return fileStat(Buffer.byteLength(PINNED_FRONTMATTER));
          }
          if (target === rootFilePath) {
            return fileStat(Buffer.byteLength(TEST_FRONTMATTER));
          }
          return dirStat();
        });
        vi.spyOn(AbsoluteFS, 'createReadStream').mockImplementation((target) =>
          runOfEvent(
            target === pinnedPath ? PINNED_FRONTMATTER : TEST_FRONTMATTER,
          ),
        );

        const result = yield* viewMemory(MEMORY_DISPLAY_ROOT);

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
      const rootPath = memoryRoot();
      const cyclePath = path.join(rootPath, 'cycle');

      vi.spyOn(AbsoluteFS, 'exists').mockResolvedValue(true);
      vi.spyOn(AbsoluteFS, 'readDir').mockImplementation(async (target) => {
        if (target === rootPath) {
          return [['cycle', FileType.Directory | FileType.SymbolicLink]];
        }
        if (target === cyclePath) {
          throw new Error('The symlink cycle must not be traversed');
        }
        throw new Error(`Unexpected readDir target: ${target}`);
      });
      vi.spyOn(AbsoluteFS, 'stat').mockImplementation(async (target) => {
        if (target === cyclePath) {
          throw new Error('The symlink cycle must not be statted');
        }
        return dirStat();
      });

      const result = yield* viewMemory(MEMORY_DISPLAY_ROOT);

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
    'keeps concurrent projects in their own captured memory roots',
    () =>
      Effect.gen(function* () {
        const first = createFakeWorkspaceRoots({ storagePath: '/storage/one' });
        const second = createFakeWorkspaceRoots({
          storagePath: '/storage/two',
        });
        const writes: string[] = [];
        vi.spyOn(AbsoluteFS, 'exists').mockResolvedValue(false);
        vi.spyOn(AbsoluteFS, 'ensureDir').mockResolvedValue();
        vi.spyOn(AbsoluteFS, 'writeAtomic').mockImplementation(
          async (target) => {
            writes.push(target);
          },
        );

        yield* Effect.forEach(
          [
            [first, 'one.md'],
            [second, 'two.md'],
          ] as const,
          ([roots, file]) =>
            new MemoryTool()
              .call({
                command: 'create',
                path: `/memories/${file}`,
                file_text: file,
              })
              .pipe(
                Effect.provide(
                  nativeToolTestLayer({
                    inScope: (operation) =>
                      runWithWorkspaceRoots(roots, operation),
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
