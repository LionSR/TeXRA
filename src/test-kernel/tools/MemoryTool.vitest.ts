// Node imports
import { Buffer } from 'node:buffer';
import * as path from 'node:path';
import { Readable } from 'node:stream';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { FileType, type FileStat } from '@platform/interfaces';
import { MEMORY_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { MEMORY_DISPLAY_ROOT } from '@tools/memory/constants';
import { MemoryTool } from '@tools/memory/MemoryTool';
import { StorageFS } from '@utils/files/storageFS';

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
  'executionId: run-7',
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

function streamOf(
  content: string,
): ReturnType<typeof StorageFS.createReadStream> {
  return Readable.from([Buffer.from(content)]) as unknown as ReturnType<
    typeof StorageFS.createReadStream
  >;
}

function viewMemory(path?: string) {
  return new MemoryTool().call({ command: 'view', path });
}

describe('MemoryTool view with an omitted path', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lists the empty memory root instead of erroring on a fresh session', async () => {
    vi.spyOn(StorageFS, 'exists').mockResolvedValue(false);

    const omitted = await viewMemory();
    const explicitRoot = await viewMemory(MEMORY_DISPLAY_ROOT);

    expect(omitted.status).toBe('executed');
    expect(omitted).toEqual(explicitRoot);
    expect(omitted).toMatchObject({
      status: 'executed',
      summary: 'Viewed empty memory directory',
    });
  });

  it('lists the memory root contents instead of erroring when memories already exist', async () => {
    vi.spyOn(StorageFS, 'exists').mockResolvedValue(true);
    vi.spyOn(StorageFS, 'stat').mockImplementation(async (target) =>
      target === MEMORY_STORAGE_DIR
        ? dirStat()
        : fileStat(TEST_FRONTMATTER.length),
    );
    vi.spyOn(StorageFS, 'readDir').mockImplementation(async (target) =>
      target === MEMORY_STORAGE_DIR ? [['notes.md', FileType.File]] : [],
    );
    vi.spyOn(StorageFS, 'read').mockResolvedValue(TEST_FRONTMATTER);
    vi.spyOn(StorageFS, 'createReadStream').mockImplementation(() =>
      streamOf(TEST_FRONTMATTER),
    );

    const omitted = await viewMemory();
    const explicitRoot = await viewMemory(MEMORY_DISPLAY_ROOT);

    expect(omitted.status).toBe('executed');
    expect(omitted).toEqual(explicitRoot);
    expect(omitted.summary).toContain('Listed directory: /memories');
    expect(omitted.output).toContain('/memories/notes.md');
  });

  it('still requires path for non-view commands, e.g. create', async () => {
    const create = await new MemoryTool().call({
      command: 'create',
      file_text: 'body',
    });
    expect(create.status).toBe('error');
    expect(create).toMatchObject({
      status: 'error',
      error: expect.stringContaining('path'),
    });
  });

  it('preserves the model-facing directory listing bytes and depth limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));

    const alphaPath = path.join(MEMORY_STORAGE_DIR, 'alpha');
    const betaPath = path.join(alphaPath, 'beta');
    const pinnedPath = path.join(alphaPath, 'pinned.md');
    const rootFilePath = path.join(MEMORY_STORAGE_DIR, 'root.md');

    vi.spyOn(StorageFS, 'exists').mockResolvedValue(true);
    vi.spyOn(StorageFS, 'readDir').mockImplementation(async (target) => {
      if (target === MEMORY_STORAGE_DIR) {
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
    vi.spyOn(StorageFS, 'stat').mockImplementation(async (target) => {
      if (target === pinnedPath) {
        return fileStat(Buffer.byteLength(PINNED_FRONTMATTER));
      }
      if (target === rootFilePath) {
        return fileStat(Buffer.byteLength(TEST_FRONTMATTER));
      }
      return dirStat();
    });
    vi.spyOn(StorageFS, 'createReadStream').mockImplementation((target) =>
      streamOf(target === pinnedPath ? PINNED_FRONTMATTER : TEST_FRONTMATTER),
    );

    const result = await viewMemory(MEMORY_DISPLAY_ROOT);

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
  });

  it('skips a symlink cycle when listing memory directories', async () => {
    const cyclePath = path.join(MEMORY_STORAGE_DIR, 'cycle');

    vi.spyOn(StorageFS, 'exists').mockResolvedValue(true);
    vi.spyOn(StorageFS, 'readDir').mockImplementation(async (target) => {
      if (target === MEMORY_STORAGE_DIR) {
        return [['cycle', FileType.Directory | FileType.SymbolicLink]];
      }
      if (target === cyclePath) {
        throw new Error('The symlink cycle must not be traversed');
      }
      throw new Error(`Unexpected readDir target: ${target}`);
    });
    vi.spyOn(StorageFS, 'stat').mockImplementation(async (target) => {
      if (target === cyclePath) {
        throw new Error('The symlink cycle must not be statted');
      }
      return dirStat();
    });

    const result = await viewMemory(MEMORY_DISPLAY_ROOT);

    expect(result).toMatchObject({
      status: 'executed',
      summary: 'Listed directory: /memories (1–1 of 1)',
    });
    expect(result.output).not.toContain('cycle');
  });
});
