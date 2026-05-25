import { describe, expect, it } from 'vitest';

import {
  cliMemoryItemDescription,
  formatCliMemoryList,
  resolveCliMemoryStoragePath,
} from '@cli/runtime/memory';
import { memorySelectWindow } from '@cli/chat/tui/forms/MemoryListForm';
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
    expect(description).toContain('2.0K');
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

  it('accepts display, storage, and shorthand paths', () => {
    expect(resolveCliMemoryStoragePath('/memories/project.md')).toBe(
      'memories/project.md',
    );
    expect(resolveCliMemoryStoragePath('memories/project.md')).toBe(
      'memories/project.md',
    );
    expect(resolveCliMemoryStoragePath('memories\\project.md')).toBe(
      'memories/project.md',
    );
    expect(resolveCliMemoryStoragePath('project.md')).toBe(
      'memories/project.md',
    );
  });

  it('rejects absolute paths outside the memory display root', () => {
    expect(() => resolveCliMemoryStoragePath('/memoriesExtra')).toThrow(
      'Invalid memory path',
    );
  });
});

describe('memorySelectWindow', () => {
  it('keeps overflow markers only when there is room for them', () => {
    expect(memorySelectWindow({ availableRows: 4, itemCount: 10 })).toEqual({
      maxVisibleItems: 1,
      showOverflow: false,
    });
    expect(memorySelectWindow({ availableRows: 12, itemCount: 10 })).toEqual({
      maxVisibleItems: 3,
      showOverflow: true,
    });
  });
});
