// Node imports
import { Buffer } from 'node:buffer';
import * as path from 'node:path';
import { Readable } from 'node:stream';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { FileType, type FileStat } from '@platform/interfaces';
import { MEMORY_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import {
  countPinnedMemories,
  walkMemoryDirectory,
} from '@tools/memory/memoryFileSystem';
import { delay } from '@utils/core';
import { StorageFS } from '@utils/files/storageFS';

const MEMORY_LISTING_CONCURRENCY = 8;
const FILE_COUNT_PER_DIRECTORY = 12;
const TEST_TIMESTAMP = Date.parse('2026-01-01T00:00:00.000Z');
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

function memoryFiles(): [string, number][] {
  return Array.from(
    { length: FILE_COUNT_PER_DIRECTORY },
    (_, index): [string, number] => [`note-${index}.md`, FileType.File],
  );
}

function readStreamFromText(
  text: string,
): ReturnType<typeof StorageFS.createReadStream> {
  return Readable.from([Buffer.from(text)]) as unknown as ReturnType<
    typeof StorageFS.createReadStream
  >;
}

function testFileStat(content: string): FileStat {
  return {
    type: FileType.File,
    ctime: TEST_TIMESTAMP,
    mtime: TEST_TIMESTAMP,
    size: Buffer.byteLength(content),
  };
}

describe('memory filesystem listing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bounds metadata reads while walking large memory directories', async () => {
    vi.spyOn(StorageFS, 'readDir').mockImplementation(async (target) => {
      if (target === MEMORY_STORAGE_DIR) {
        return [
          ['alpha', FileType.Directory],
          ['beta', FileType.Directory],
        ];
      }
      if (
        target === path.join(MEMORY_STORAGE_DIR, 'alpha') ||
        target === path.join(MEMORY_STORAGE_DIR, 'beta')
      ) {
        return memoryFiles();
      }
      throw new Error(`Unexpected readDir target: ${target}`);
    });

    let activeMetadataReads = 0;
    let maxActiveMetadataReads = 0;
    vi.spyOn(StorageFS, 'stat').mockImplementation(async () => {
      activeMetadataReads += 1;
      maxActiveMetadataReads = Math.max(
        maxActiveMetadataReads,
        activeMetadataReads,
      );

      await delay(5);
      activeMetadataReads -= 1;
      return testFileStat(TEST_FRONTMATTER);
    });

    vi.spyOn(StorageFS, 'createReadStream').mockImplementation(() =>
      readStreamFromText(TEST_FRONTMATTER),
    );

    const items = [];
    for await (const item of walkMemoryDirectory(MEMORY_STORAGE_DIR)) {
      items.push(item);
    }

    expect(items).toHaveLength(FILE_COUNT_PER_DIRECTORY * 2);
    expect(maxActiveMetadataReads).toBeGreaterThan(1);
    expect(maxActiveMetadataReads).toBeLessThanOrEqual(
      MEMORY_LISTING_CONCURRENCY,
    );
  });

  it('stops metadata reads once the pinned-memory limit is reached', async () => {
    const cyclePath = path.join(MEMORY_STORAGE_DIR, 'cycle');
    const files: [string, number][] = [
      ['cycle', FileType.Directory | FileType.SymbolicLink],
      ...Array.from({ length: 100 }, (_, index): [string, number] => [
        `pinned-${index}.md`,
        FileType.File,
      ]),
    ];
    vi.spyOn(StorageFS, 'exists').mockResolvedValue(true);
    vi.spyOn(StorageFS, 'readDir').mockResolvedValue(files);
    vi.spyOn(StorageFS, 'stat').mockImplementation(async (target) => {
      if (target === cyclePath) {
        throw new Error('The symlink cycle must not be statted');
      }
      return testFileStat(PINNED_FRONTMATTER);
    });
    const readStream = vi
      .spyOn(StorageFS, 'createReadStream')
      .mockImplementation(() => readStreamFromText(PINNED_FRONTMATTER));

    await expect(countPinnedMemories(1)).resolves.toBe(1);
    expect(readStream.mock.calls.length).toBeLessThan(files.length);
  });
});
