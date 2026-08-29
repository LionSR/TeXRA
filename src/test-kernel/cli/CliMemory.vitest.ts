import { describe, expect, it, vi } from 'vitest';

import {
  CLI_MEMORY_LIST_LIMIT,
  cliMemoryItemDescription,
  formatCliMemoryList,
  loadCliMemoryDetail,
} from '@cli/runtime/memory';
import type { MemoryViewItem } from '@shared/schemas';

vi.mock('@tools/memory/memoryFileSystem', () => ({
  loadMemoryPreview: async () => ({ lineCount: 1, preview: 'preview' }),
}));

const item: MemoryViewItem = {
  displayPath: '/memories/project.md',
  storagePath: 'memories/project.md',
  size: 2048,
  mtime: '2026-01-02T03:04:05.000Z',
  modifiedBy: 'researcher',
  pinned: true,
};

describe('CLI memory formatting', () => {
  it('formats memory rows with stable user-facing fields', () => {
    const description = cliMemoryItemDescription(item);

    expect(description).toContain('pinned');
    expect(description).toContain('2 KiB');
    expect(description).toContain('by researcher');
  });

  it('does not treat the Unix epoch as an unknown modification date', () => {
    const description = cliMemoryItemDescription({
      ...item,
      mtime: '1970-01-01T00:00:00.000Z',
    });

    expect(description).toContain('modified:');
    expect(description).not.toContain('modified: unknown');
  });

  it('formats an empty memory listing explicitly', () => {
    expect(formatCliMemoryList([])).toBe('No memory files found.');
  });

  it('limits long memory listings and reports hidden rows', () => {
    const list = formatCliMemoryList(
      Array.from({ length: CLI_MEMORY_LIST_LIMIT + 1 }, (_unused, index) => ({
        ...item,
        displayPath: `/memories/project-${index}.md`,
      })),
    );

    expect(list).toContain(`Memories (${CLI_MEMORY_LIST_LIMIT + 1}):`);
    expect(list).toContain('/memories/project-0.md');
    expect(list).not.toContain(`/memories/project-${CLI_MEMORY_LIST_LIMIT}.md`);
    expect(list).toContain('... 1 more');
  });

  it.each([
    '/memories/project.md',
    'memories/project.md',
    'memories\\project.md',
    'project.md',
  ])('accepts the path form %s', async (input) => {
    await expect(loadCliMemoryDetail(input)).resolves.toMatchObject({
      path: '/memories/project.md',
    });
  });

  it('rejects absolute paths outside the memory display root', async () => {
    await expect(loadCliMemoryDetail('/memoriesExtra')).rejects.toThrow(
      'Invalid memory path',
    );
  });

  it('reports the original display path when a memory path escapes the root', async () => {
    await expect(
      loadCliMemoryDetail('/memories/../outside.md'),
    ).rejects.toThrow('Invalid memory path: /memories/../outside.md');
  });
});
