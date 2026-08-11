/**
 * Tests for `normalizeConversationForExport` — the provider-shape normalization
 * that collapses Anthropic, OpenAI (Chat Completions and Response API), and
 * Google GenAI messages into format-agnostic `ExportNode[]`.
 *
 * Coverage targets from the issue:
 *  - OpenAI Responses function-call items (top-level function_call,
 *    function_call_output with mixed input_text/input_image/input_file parts)
 *  - Google thought parts (field-based `thought` flag + `text`)
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
// OpenAI Response API — function calls
// ---------------------------------------------------------------------------

describe('OpenAI Responses API', () => {
  it('handles top-level function_call items', () => {
    const nodes = normalize([
      {
        type: 'function_call',
        call_id: 'call_42',
        name: 'search_docs',
        arguments: '{"query":"TypeScript generics"}',
      },
    ]);

    expectSingleNode(nodes, 'tool-call', {
      name: 'search_docs',
      input: '{"query":"TypeScript generics"}',
    });
  });

  it('handles top-level function_call with object arguments', () => {
    const nodes = normalize([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'run',
        arguments: { x: 1, y: 2 },
      },
    ]);

    expectSingleNode(nodes, 'tool-call', { name: 'run' });
    // Object arguments should be serialised.
    expect(JSON.parse(nodesOfKind(nodes, 'tool-call')[0].input)).toEqual({
      x: 1,
      y: 2,
    });
  });

  it('handles function_call with missing name (falls back to "unknown")', () => {
    const nodes = normalize([
      { type: 'function_call', call_id: 'call_1', arguments: '{}' },
    ]);

    expect(nodesOfKind(nodes, 'tool-call')).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'tool-call', name: 'unknown' });
  });

  it('handles assistant messages with output_text content parts', () => {
    const nodes = normalize([
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'response text' }],
      },
    ]);

    expect(nodesOfKind(nodes, 'assistant-text')).toEqual([
      { kind: 'assistant-text', text: 'response text' },
    ]);
  });

  it('handles function_call_output with array output (mixed parts)', () => {
    const nodes = normalize([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'fetch_notes',
        arguments: '{"topic":"sdk"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'first line' },
          { type: 'input_text', text: '' },
          { type: 'input_image', image_url: 'https://example.com/img.png' },
          { type: 'input_file', file_id: 'file_123' },
        ],
      },
    ]);

    // First node is the tool call, second is the tool result.
    expectSingleNode(nodes, 'tool-result', {
      text: 'first line\n\n[image attachment]\n[file attachment]',
    });
  });

  it('handles function_call_output with string output', () => {
    const nodes = normalize([
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'plain string',
      },
    ]);

    expectSingleNode(nodes, 'tool-result', { text: 'plain string' });
  });

  it('handles function_call_output with object output', () => {
    const nodes = normalize([
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: { status: 'ok', data: [1, 2, 3] },
      },
    ]);

    const results = nodesOfKind(nodes, 'tool-result');
    expect(results).toHaveLength(1);
    // Object output should be JSON-stringified.
    expect(() => JSON.parse(results[0].text)).not.toThrow();
  });

  it('correctly resets lastAssistantHadToolUse after function_call_output', () => {
    // A function_call_output should reset the flag so the next user message
    // is rendered as a user-message, not a tool-result.
    const nodes = normalize([
      { type: 'function_call', call_id: 'c1', name: 't', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'done' },
      { role: 'user', content: 'What next?' },
    ]);

    expect(nodesOfKind(nodes, 'user-message')).toHaveLength(1);
  });
});

describe('VS Code language-model messages', () => {
  it('normalizes text, tool calls, and tool results', () => {
    expect(
      normalize([
        {
          role: 'user',
          content: [{ kind: 'text', text: 'Inspect the proof.' }],
        },
        {
          role: 'assistant',
          content: [
            { kind: 'text', text: 'I will inspect it.' },
            {
              kind: 'toolCall',
              callId: 'call-1',
              name: 'read_file',
              input: { path: 'Main.lean' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { kind: 'toolResult', callId: 'call-1', text: 'file contents' },
          ],
        },
      ]),
    ).toEqual([
      {
        kind: 'user-message',
        parts: [{ type: 'text', text: 'Inspect the proof.' }],
      },
      { kind: 'assistant-text', text: 'I will inspect it.' },
      {
        kind: 'tool-call',
        name: 'read_file',
        input: '{\n  "path": "Main.lean"\n}',
      },
      { kind: 'tool-result', text: 'file contents' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Google GenAI — thought parts
// ---------------------------------------------------------------------------

describe('Google GenAI', () => {
  it('filters out thought parts (field-based discrimination)', () => {
    // Google GenAI sets `thought: true` on the Part object itself.
    // The exporter must suppress thinking blocks so they don't appear
    // as visible assistant text.
    const nodes = normalize([
      {
        role: 'model',
        parts: [
          { thought: true, text: 'Let me think about this carefully...' },
          { text: 'Here is the answer.' },
        ],
      },
    ]);

    // Only the non-thought text should produce an assistant-text node.
    expectSingleNode(nodes, 'assistant-text', { text: 'Here is the answer.' });
  });

  it('handles thought-only model messages (no visible output)', () => {
    const nodes = normalize([
      {
        role: 'model',
        parts: [{ thought: true, text: 'internal reasoning...' }],
      },
    ]);

    // No visible nodes should be produced.
    expect(nodes).toHaveLength(0);
  });

  it('uses "model" role like "assistant"', () => {
    const nodes = normalize([
      { role: 'model', parts: [{ text: 'Generated content' }] },
    ]);

    expect(nodesOfKind(nodes, 'assistant-text')).toHaveLength(1);
  });

  it('handles functionCall parts in Google GenAI messages', () => {
    const nodes = normalize([
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'get_weather', args: { city: 'London' } } },
        ],
      },
    ]);

    expectSingleNode(nodes, 'tool-call', { name: 'get_weather' });
  });

  it('handles functionResponse parts in Google GenAI messages', () => {
    // A functionResponse on a user message is rendered as a tool-result
    // when it follows a model functionCall (set via lastAssistantHadToolUse).
    const nodes = normalize([
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'get_weather', args: { city: 'London' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'get_weather', response: { temp: 22 } } },
        ],
      },
    ]);

    const results = nodesOfKind(nodes, 'tool-result');
    expect(results).toHaveLength(1);
  });

  it.each([
    {
      shape: 'inlineData parts (image)',
      part: { inlineData: { mimeType: 'image/png', data: 'base64...' } },
      attachmentType: 'image',
    },
    {
      shape: 'inlineData parts (document)',
      part: { inlineData: { mimeType: 'application/pdf', data: 'base64...' } },
      attachmentType: 'document',
    },
    {
      shape: 'fileData parts (URI-based uploaded files)',
      part: { fileData: { mimeType: 'image/jpeg', fileUri: 'gs://...' } },
      attachmentType: 'image',
    },
  ])('handles $shape', ({ part, attachmentType }) => {
    const nodes = normalize([{ role: 'user', parts: [part] }]);

    expect(nodesOfKind(nodes, 'user-message')).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: 'user-message',
      parts: [{ type: 'attachment', attachmentType }],
    });
  });
});

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
      shape: 'archived flat',
      block: {
        type: 'web_fetch_tool_result',
        url: 'https://example.com/archived',
        title: 'Archived Page',
        page_content: 'Archived page content',
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
            url: 'https://example.com/archived-without-metadata',
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
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

describe('OpenAI Chat Completions', () => {
  it('handles assistant tool_calls array', () => {
    const nodes = normalize([
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
          },
        ],
      },
    ]);

    expectSingleNode(nodes, 'tool-call', {
      name: 'get_weather',
      input: '{"city":"NYC"}',
    });
  });

  it('filters out non-function tool_calls (custom type)', () => {
    const nodes = normalize([
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_fn',
            type: 'function',
            function: { name: 'valid_tool', arguments: '{}' },
          },
          {
            id: 'call_custom',
            type: 'custom',
            custom: { name: 'custom_tool', input: '{}' },
          },
        ],
      },
    ]);

    expectSingleNode(nodes, 'tool-call', { name: 'valid_tool' });
  });

  it('handles tool role messages', () => {
    const nodes = normalize([
      { role: 'tool', tool_call_id: 'call_1', content: 'result text' },
    ]);

    expectSingleNode(nodes, 'tool-result', { text: 'result text' });
  });

  it('handles system messages (ignored — no visible node)', () => {
    const nodes = normalize([
      { role: 'system', content: 'You are a helpful assistant.' },
    ]);

    // System messages should produce no nodes.
    expect(nodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('handles empty messages array', () => {
    expect(normalize([])).toEqual([]);
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

    // Whitespace-only text should be filtered out.
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
  // and web_fetch_tool_result are — see AnthropicStreamHandler) and fall
  // through to the switch's `default: return null`, same as any other
  // unrecognized block type.
  it('does not map unused code-execution block types to a node', () => {
    const nodes = normalize([
      {
        role: 'assistant',
        content: [
          { type: 'code_execution_tool_result', content: 'execution output' },
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
