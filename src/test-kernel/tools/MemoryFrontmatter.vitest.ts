// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - memory metadata
import {
  buildFile,
  createMeta,
  parseFrontmatter,
  setPinnedMeta,
  type MemoryFileMeta,
} from '@tools/memory/memoryMeta';

describe('memory frontmatter (yaml-backed)', () => {
  it('round-trips metadata through build and parse', () => {
    const meta: MemoryFileMeta = {
      modifiedBy: 'reviser-agent',
      executionId: 'exec_123',
      modifiedAt: '2026-06-20T14:30:45.123Z',
      pinned: true,
    };
    const file = buildFile('the body\nmore body\n', meta);

    const parsed = parseFrontmatter(file);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.content).toBe('the body\nmore body\n');
  });

  it('omits optional fields when not set', () => {
    const meta: MemoryFileMeta = {
      modifiedBy: 'agent',
      modifiedAt: '2026-06-20T14:30:45.123Z',
    };
    const file = buildFile('body', meta);

    // executionId and pinned must not appear in the serialized block.
    expect(file).not.toContain('executionId');
    expect(file).not.toContain('pinned');

    const parsed = parseFrontmatter(file);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.meta?.executionId).toBeUndefined();
    expect(parsed.meta?.pinned).toBeUndefined();
  });

  it('parses a legacy hand-written block (unquoted values)', () => {
    const legacy = [
      '---',
      'modifiedBy: agent-name',
      'executionId: abc',
      'modifiedAt: 2026-06-20T14:30:45.123Z',
      'pinned: true',
      '---',
      'legacy body',
    ].join('\n');

    const parsed = parseFrontmatter(legacy);
    expect(parsed.meta).toEqual({
      modifiedBy: 'agent-name',
      executionId: 'abc',
      modifiedAt: '2026-06-20T14:30:45.123Z',
      pinned: true,
    });
    expect(parsed.content).toBe('legacy body');
  });

  // In every unreadable case the full raw text is preserved as content
  // (back-compat with the old parser).
  it.each([
    {
      scenario: 'no frontmatter fence',
      raw: 'just some content\nwith no frontmatter',
    },
    {
      scenario: 'a block lacking modifiedBy',
      raw: ['---', 'foo: bar', 'modifiedAt: 2026-01-01', '---', 'body'].join(
        '\n',
      ),
    },
    {
      scenario: 'malformed YAML',
      raw: ['---', 'modifiedBy: "unterminated', '---', 'body'].join('\n'),
    },
  ])('returns null metadata with full content for $scenario', ({ raw }) => {
    const parsed = parseFrontmatter(raw);
    expect(parsed.meta).toBeNull();
    expect(parsed.content).toBe(raw);
  });

  it('quotes pathological values so they survive a round-trip', () => {
    const meta: MemoryFileMeta = {
      modifiedBy: 'agent: with colon',
      modifiedAt: '2026-06-20T14:30:45.123Z',
    };
    const file = buildFile('body', meta);
    const parsed = parseFrontmatter(file);
    expect(parsed.meta?.modifiedBy).toBe('agent: with colon');
  });

  it('buildFile returns content unchanged when meta is null', () => {
    expect(buildFile('raw content', null)).toBe('raw content');
  });

  it('createMeta carries the pinned flag from existing metadata', () => {
    const existing: MemoryFileMeta = {
      modifiedBy: 'old',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      pinned: true,
    };
    const meta = createMeta('new-agent', 'exec_9', existing);
    expect(meta?.modifiedBy).toBe('new-agent');
    expect(meta?.executionId).toBe('exec_9');
    expect(meta?.pinned).toBe(true);
  });

  it('createMeta returns null when no agent name is available', () => {
    expect(createMeta(undefined, 'exec_9')).toBeNull();
  });

  it('setPinnedMeta toggles the pinned flag, synthesizing meta when absent', () => {
    const pinned = setPinnedMeta(null, true);
    expect(pinned.pinned).toBe(true);
    expect(pinned.modifiedBy).toBe('user');

    const unpinned = setPinnedMeta(pinned, false);
    expect(unpinned.pinned).toBeUndefined();
  });
});
