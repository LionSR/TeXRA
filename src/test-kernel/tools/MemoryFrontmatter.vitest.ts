// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - memory metadata
import {
  buildFile,
  parseFrontmatter,
  type MemoryFileMeta,
} from '@tools/memory/memoryMeta';

describe('memory frontmatter (yaml-backed) (packages/harness/src/common/memory/memoryMeta.ts)', () => {
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
