import { describe, expect, it } from 'vitest';

import {
  cliMemoryItemDescription,
  cliMemoryStoragePathFromInput,
  formatCliMemoryList,
} from '@cli/runtime/memory';
import type { MemoryViewItem } from '@shared/schemas';

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
      [item, { ...item, displayPath: '/memories/other.md' }],
      {
        limit: 1,
      },
    );

    expect(list).toContain('Memories (2):');
    expect(list).toContain('/memories/project.md');
    expect(list).toContain('... 1 more');
  });

  it.each([
    '/memories/project.md',
    'memories/project.md',
    'memories\\project.md',
    'project.md',
  ])('accepts the path form %s', (input) => {
    expect(cliMemoryStoragePathFromInput(input)).toBe('memories/project.md');
  });

  it('rejects absolute paths outside the memory display root', () => {
    expect(() => cliMemoryStoragePathFromInput('/memoriesExtra')).toThrow(
      'Invalid memory path',
    );
  });

  it('reports the original display path when a memory path escapes the root', () => {
    expect(() =>
      cliMemoryStoragePathFromInput('/memories/../outside.md'),
    ).toThrow('Invalid memory path: /memories/../outside.md');
  });
});
