// Standard library imports
import { Buffer } from 'node:buffer';
import * as path from 'node:path';
import { Readable } from 'node:stream';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Platform imports
import { FileType, type FileStat } from '@platform/interfaces/filesystem';

// Local imports - settings memory
import { walkMemoryDirectory } from '@tools/memory/memoryFileSystem';
import { MEMORY_STORAGE_ROOT } from '@tools/memory/constants';
import { StorageFS } from '@utils/files';

const MEMORY_LISTING_CONCURRENCY = 8;
const FILE_COUNT_PER_DIRECTORY = 12;
const TEST_TIMESTAMP = Date.parse('2026-01-01T00:00:00.000Z');
const TEST_FRONTMATTER = [
  '---',
  'modifiedBy: test-agent',
  'modifiedAt: 2026-01-01T00:00:00.000Z',
  '---',
  'body',
].join('\n');

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

function testFileStat(): FileStat {
  return {
    type: FileType.File,
    ctime: TEST_TIMESTAMP,
    mtime: TEST_TIMESTAMP,
    size: Buffer.byteLength(TEST_FRONTMATTER),
  };
}

describe('memory filesystem listing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bounds metadata reads while walking large memory directories', async () => {
    vi.spyOn(StorageFS, 'readDir').mockImplementation(async (target) => {
      if (target === MEMORY_STORAGE_ROOT) {
        return [
          ['alpha', FileType.Directory],
          ['beta', FileType.Directory],
        ];
      }
      if (
        target === path.join(MEMORY_STORAGE_ROOT, 'alpha') ||
        target === path.join(MEMORY_STORAGE_ROOT, 'beta')
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

      await new Promise((resolve) => setTimeout(resolve, 5));
      activeMetadataReads -= 1;
      return testFileStat();
    });

    vi.spyOn(StorageFS, 'createReadStream').mockImplementation(() =>
      readStreamFromText(TEST_FRONTMATTER),
    );

    const items = await walkMemoryDirectory(MEMORY_STORAGE_ROOT);

    expect(items).toHaveLength(FILE_COUNT_PER_DIRECTORY * 2);
    expect(maxActiveMetadataReads).toBeGreaterThan(1);
    expect(maxActiveMetadataReads).toBeLessThanOrEqual(
      MEMORY_LISTING_CONCURRENCY,
    );
  });
});
