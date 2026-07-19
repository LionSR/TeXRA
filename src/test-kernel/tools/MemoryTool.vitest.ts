// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { FileType, type FileStat } from '@platform/interfaces';
import { MEMORY_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { MEMORY_DISPLAY_ROOT } from '@tools/memory/constants';
import { MemoryTool } from '@tools/memory/MemoryTool';
import { StorageFS } from '@utils/files';

const TEST_TIMESTAMP = Date.parse('2026-01-01T00:00:00.000Z');
const TEST_FRONTMATTER = [
  '---',
  'modifiedBy: test-agent',
  'modifiedAt: 2026-01-01T00:00:00.000Z',
  '---',
  'note body',
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

describe('MemoryTool view with an omitted path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the empty memory root instead of erroring on a fresh session', async () => {
    vi.spyOn(StorageFS, 'exists').mockResolvedValue(false);

    const omitted = await new MemoryTool().call({ command: 'view' });
    const explicitRoot = await new MemoryTool().call({
      command: 'view',
      path: MEMORY_DISPLAY_ROOT,
    });

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

    const omitted = await new MemoryTool().call({ command: 'view' });
    const explicitRoot = await new MemoryTool().call({
      command: 'view',
      path: MEMORY_DISPLAY_ROOT,
    });

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
    expect(create).toMatchObject({
      status: 'error',
      error: 'Parameter `path` is required for command: create',
    });
  });
});
