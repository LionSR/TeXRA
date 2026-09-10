/**
 * Tests for `normalizeConversationForExport` — the normalization that
 * collapses completed-run `{role, content}` messages into format-agnostic
 * `ExportNode[]`.
 */

import { describe, expect, it } from 'vitest';

import { normalizeConversationForExport } from '@agent/export/normalizeConversation';
import type { ExportNode } from '@agent/export/schemas';
import type { MediaAttachmentKind } from '@shared/schemas';

const MEDIA_ATTACHMENT_KIND_COVERAGE: Record<MediaAttachmentKind, true> = {
  image: true,
  document: true,
};
const MEDIA_ATTACHMENT_KINDS = Object.keys(
  MEDIA_ATTACHMENT_KIND_COVERAGE,
) as MediaAttachmentKind[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(messages: unknown[]): ExportNode[] {
  return normalizeConversationForExport(messages);
}

function nodesOfKind<K extends ExportNode['kind']>(
  nodes: ExportNode[],
  kind: K,
): Extract<ExportNode, { kind: K }>[] {
  return nodes.filter(
    (node): node is Extract<ExportNode, { kind: K }> => node.kind === kind,
  );
}

/** Asserts exactly one node of `kind` exists and matches `expected`. */
function expectSingleNode<K extends ExportNode['kind']>(
  nodes: ExportNode[],
  kind: K,
  expected: Record<string, unknown>,
): void {
  const matches = nodesOfKind(nodes, kind);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ kind, ...expected });
}

// ---------------------------------------------------------------------------
// Anthropic-style content blocks
// ---------------------------------------------------------------------------

describe('Anthropic-style messages', () => {
  it('handles simple text user message', () => {
    const nodes = normalize([{ role: 'user', content: 'Hello' }]);

    expect(nodesOfKind(nodes, 'user-message')).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: 'user-message',
      parts: [{ type: 'text', text: 'Hello' }],
    });
  });

  it('handles assistant text block', () => {
    const nodes = normalize([
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
    ]);

    expect(nodesOfKind(nodes, 'assistant-text')).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: 'assistant-text',
      text: 'Hi there!',
    });
  });

  it('handles tool_use block', () => {
    const nodes = normalize([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'read_file',
            input: { path: '/tmp/test.txt' },
          },
        ],
      },
    ]);

    expectSingleNode(nodes, 'tool-call', { name: 'read_file' });
  });

  it('handles tool_result user message (converted to tool-result node)', () => {
    const nodes = normalize([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'read_file',
            input: {},
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: 'file contents',
          },
        ],
      },
    ]);

    expectSingleNode(nodes, 'tool-result', { text: 'file contents' });
  });

  it('handles web_search_tool_result blocks', () => {
    const nodes = normalize([
      {
        role: 'assistant',
        content: [
          {
            type: 'web_search_tool_result',
            content: [
              {
                type: 'web_search_result',
                url: 'https://example.com/page',
                title: 'Example Page',
              },
            ],
          },
        ],
      },
    ]);

    expectSingleNode(nodes, 'web-search-results', {
      results: [{ title: 'Example Page', url: 'https://example.com/page' }],
    });
  });

  it.each([
    {
      shape: 'live Anthropic nested',
      block: {
        type: 'web_fetch_tool_result',
        content: {
          type: 'web_fetch_result',
          url: 'https://example.com/live',
          content: {
            type: 'document',
            title: 'Live Page',
            source: {
              type: 'text',
              media_type: 'text/plain',
              data: 'Live page content',
            },
          },
        },
      },
      expected: {
        kind: 'web-fetch' as const,
        url: 'https://example.com/live',
        title: 'Live Page',
        content: 'Live page content',
      },
    },
    {
      shape: 'archived',
      block: {
        type: 'web_fetch_tool_result',
        content: {
          type: 'web_fetch_result',
          url: 'https://example.com/archived',
          retrieved_at: null,
          content: {
            type: 'document',
            title: 'Archived Page',
            source: {
              type: 'text',
              data: 'Archived page content',
            },
          },
        },
      },
      expected: {
        kind: 'web-fetch' as const,
        url: 'https://example.com/archived',
        title: 'Archived Page',
        content: 'Archived page content',
      },
    },
  ])(
    'normalizes $shape web_fetch_tool_result blocks',
    ({ block, expected }) => {
      const nodes = normalize([
        {
          role: 'assistant',
          content: [block],
        },
      ]);

      expect(nodesOfKind(nodes, 'web-fetch')).toEqual([expected]);
    },
  );

  it('keeps available fields and ignores malformed or absent optional web-fetch fields', () => {
    const nodes = normalize([
      {
        role: 'assistant',
        content: [
          {
            type: 'web_fetch_tool_result',
            content: {
              type: 'web_fetch_result',
              url: 'https://example.com/live-without-metadata',
              content: {
                type: 'document',
                title: null,
                source: { type: 'text', data: 42 },
              },
            },
          },
          {
            type: 'web_fetch_tool_result',
            content: {
              type: 'web_fetch_result',
              url: 'https://example.com/archived-without-metadata',
              retrieved_at: null,
            },
          },
          {
            type: 'web_fetch_tool_result',
            content: {
              type: 'web_fetch_tool_result_error',
              error_code: 'url_not_accessible',
            },
          },
          {
            type: 'web_fetch_tool_result',
            content: {
              type: 'web_fetch_result',
              content: { type: 'document' },
            },
          },
        ],
      },
    ]);

    expect(nodesOfKind(nodes, 'web-fetch')).toEqual([
      {
        kind: 'web-fetch',
        url: 'https://example.com/live-without-metadata',
        title: undefined,
        content: undefined,
      },
      {
        kind: 'web-fetch',
        url: 'https://example.com/archived-without-metadata',
        title: undefined,
        content: undefined,
      },
    ]);
  });

  it('handles server_tool_use (web_search)', () => {
    const nodes = normalize([
      {
        role: 'assistant',
        content: [
          {
            type: 'server_tool_use',
            name: 'web_search',
            input: { query: 'TypeScript generics' },
          },
        ],
      },
    ]);

    expectSingleNode(nodes, 'web-search', { query: 'TypeScript generics' });
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('handles empty messages array', () => {
    expect(normalize([])).toEqual([]);
  });

  it('ignores system messages (no visible node)', () => {
    const nodes = normalize([
      { role: 'system', content: 'You are a helpful assistant.' },
    ]);

    expect(nodes).toHaveLength(0);
  });

  it('skips null/undefined/non-object entries', () => {
    const nodes = normalize([
      null,
      undefined,
      42,
      'string',
      { role: 'user', content: 'valid' },
    ]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'user-message' });
  });

  it('handles messages with no role (defaults to "unknown")', () => {
    // Messages with no role should be silently skipped (no known role match).
    const nodes = normalize([{ content: 'orphan' }]);

    expect(nodes).toHaveLength(0);
  });

  it('handles content as object (JSON stringified)', () => {
    const nodes = normalize([
      { role: 'user', content: { nested: { value: 42 } } },
    ]);

    expect(nodesOfKind(nodes, 'user-message')).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: 'user-message',
      parts: [
        { type: 'text', text: '{\n  "nested": {\n    "value": 42\n  }\n}' },
      ],
    });
  });

  it('produces user-message after non-tool-use assistant text', () => {
    // When the last assistant block was text (not tool_use), the next user
    // message should be a user-message, not a tool-result.
    const nodes = normalize([
      { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
      { role: 'user', content: 'Follow-up question' },
    ]);

    expect(nodesOfKind(nodes, 'user-message')).toHaveLength(1);
    expect(nodesOfKind(nodes, 'tool-result')).toHaveLength(0);
  });

  it('handles empty/whitespace-only assistant text (suppressed)', () => {
    const nodes = normalize([
      { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    ]);

    expect(nodesOfKind(nodes, 'assistant-text')).toHaveLength(0);
  });

  it('handles images in user content blocks', () => {
    const nodes = normalize([
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', data: '...' } }],
      },
    ]);

    expect(nodesOfKind(nodes, 'user-message')).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: 'user-message',
      parts: [{ type: 'attachment', attachmentType: 'image' }],
    });
  });

  // code_execution_tool_result / bash_code_execution_tool_result /
  // text_editor_code_execution_tool_result are not emitted by any model
  // handler in this codebase (only server_tool_use, web_search_tool_result,
  // and web_fetch_tool_result are — see AnthropicStreamHandler) and land
  // in the switch's `case undefined` arm, same as any other unrecognized
  // block type.
  it('does not map unused code-execution block types to a node', () => {
    const nodes = normalize([
      {
        role: 'assistant',
        content: [
          { type: 'code_execution_tool_result', content: 'run output' },
          { type: 'bash_code_execution_tool_result', content: 'bash output' },
          {
            type: 'text_editor_code_execution_tool_result',
            content: 'editor output',
          },
        ],
      },
    ]);

    expect(nodesOfKind(nodes, 'tool-result')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Attachment-marker blocks (`{ type: kind }`) — round trip through export
// ---------------------------------------------------------------------------

describe('attachment-marker blocks', () => {
  it('round-trips every MediaAttachmentKind through normalizeConversationForExport', () => {
    // Callers that only recorded the attachment *kind* (never the bytes —
    // see completedRunArchive's userMessageEntryToMessages) synthesize the
    // marker block as a bare `{ type: kind }`. Prove the round trip for every
    // kind the schema defines, so the marker shape and this coverage record
    // both require an explicit update if a kind is added or renamed.
    //
    // The coverage record above makes this exhaustive at typecheck time.
    for (const kind of MEDIA_ATTACHMENT_KINDS) {
      const nodes = normalize([
        {
          role: 'user',
          content: [{ type: 'text', text: 'see attached' }, { type: kind }],
        },
      ]);

      expect(nodesOfKind(nodes, 'user-message')).toHaveLength(1);
      expect(nodes[0]).toMatchObject({
        kind: 'user-message',
        parts: [
          { type: 'text', text: 'see attached' },
          { type: 'attachment', attachmentType: kind },
        ],
      });
    }
  });
});
