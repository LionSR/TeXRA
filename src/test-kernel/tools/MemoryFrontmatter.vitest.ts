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

describe('memory frontmatter (yaml-backed) (src/tools/memory/memoryMeta.ts)', () => {
  it('round-trips metadata through build and parse', () => {
    const meta: MemoryFileMeta = {
      modifiedBy: 'reviser-agent',
      runId: 'exec_123',
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

    // runId and pinned must not appear in the serialized block.
    expect(file).not.toContain('runId');
    expect(file).not.toContain('pinned');

    const parsed = parseFrontmatter(file);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.meta?.runId).toBeUndefined();
    expect(parsed.meta?.pinned).toBeUndefined();
  });

  it('parses a block using CRLF line endings', () => {
    const crlf = [
      '---',
      'modifiedBy: agent-name',
      'modifiedAt: 2026-06-20T14:30:45.123Z',
      '---',
      'crlf body',
    ].join('\r\n');

    const parsed = parseFrontmatter(crlf);
    expect(parsed.meta).toEqual({
      modifiedBy: 'agent-name',
      modifiedAt: '2026-06-20T14:30:45.123Z',
    });
    expect(parsed.content).toBe('crlf body');
  });

  it('preserves CRLF bytes inside a multi-line body untouched', () => {
    // The fence lines use CRLF (Windows-edited file), but the content
    // deliberately mixes CRLF and LF within the body to prove only the
    // fence-matching is line-ending-tolerant: parseFrontmatter must not
    // flatten the body's own line endings when it round-trips through a
    // write-back (pin/unpin, str_replace, insert all rewrite `content`
    // verbatim).
    const body = 'line1\r\nline2\nline3\r\n';
    const raw =
      [
        '---',
        'modifiedBy: agent-name',
        'modifiedAt: 2026-06-20T14:30:45.123Z',
        '---',
      ].join('\r\n') +
      '\r\n' +
      body;

    const parsed = parseFrontmatter(raw);
    expect(parsed.meta).toEqual({
      modifiedBy: 'agent-name',
      modifiedAt: '2026-06-20T14:30:45.123Z',
    });
    expect(parsed.content).toBe(body);
  });

  it('parses a legacy hand-written block (unquoted values)', () => {
    const legacy = [
      '---',
      'modifiedBy: agent-name',
      'runId: abc',
      'modifiedAt: 2026-06-20T14:30:45.123Z',
      'pinned: true',
      '---',
      'legacy body',
    ].join('\n');

    const parsed = parseFrontmatter(legacy);
    expect(parsed.meta).toEqual({
      modifiedBy: 'agent-name',
      runId: 'abc',
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
});
