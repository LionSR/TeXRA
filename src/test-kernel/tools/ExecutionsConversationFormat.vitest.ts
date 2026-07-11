import { describe, expect, it } from 'vitest';

import { formatConversation } from '@tools/executions/conversationFormat';

describe('formatConversation', () => {
  it('preserves ASCII truncation for conversation output', () => {
    const output = formatConversation([
      { role: 'assistant', content: 'x'.repeat(501) },
    ]);

    expect(output).toContain(`${'x'.repeat(497)}...`);
    expect(output).not.toContain('…');
  });

  it('formats typed content blocks (text, tool_use, tool_result)', () => {
    const output = formatConversation([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', name: 'read', input: { path: 'a.tex' } },
          { type: 'tool_result', content: 'done' },
        ],
      },
    ]);

    expect(output).toContain('hello');
    expect(output).toContain('[tool_use: read({"path":"a.tex"})]');
    expect(output).toContain('[tool_result: done]');
  });

  it('formats media blocks as readable attachment markers', () => {
    const output = formatConversation([
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,abc' },
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf' },
          },
          { inlineData: { mimeType: 'image/png', data: 'abc' } },
        ],
      },
    ]);

    expect(output).toContain('[image attachment]');
    expect(output).toContain('[document attachment]');
    expect(output).not.toContain('base64');
  });

  it('renders known blocks with missing fields and JSON-stringifies unknown shapes', () => {
    const output = formatConversation([
      {
        role: 'assistant',
        content: [
          { type: 'text' }, // known shape, missing text → empty, not JSON fallback
          { type: 'mystery', foo: 1 }, // unknown shape → JSON fallback
          'raw string block', // bare string passthrough
        ],
      },
    ]);

    expect(output).toContain('raw string block');
    expect(output).toContain('{"type":"mystery","foo":1}');
    // A text block with no text contributes an empty line, never its JSON form.
    expect(output).not.toContain('{"type":"text"}');
  });

  it('formats server_tool_use blocks as a tool_use marker (not a JSON dump)', () => {
    const output = formatConversation([
      {
        role: 'assistant',
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: { query: 'texra latex' },
          },
        ],
      },
    ]);

    expect(output).toContain('[tool_use: web_search({"query":"texra latex"})]');
    expect(output).not.toContain('"type":"server_tool_use"');
  });

  it('formats web_search_tool_result blocks as a compact result list', () => {
    const output = formatConversation([
      {
        role: 'assistant',
        content: [
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
              {
                type: 'web_search_result',
                title: 'TeXRA',
                url: 'https://texra.ai',
                encrypted_content: 'abc',
              },
              {
                type: 'web_search_result',
                title: 'TeXRA docs',
                url: 'https://texra.ai/docs',
                encrypted_content: 'def',
              },
            ],
          },
        ],
      },
    ]);

    expect(output).toContain(
      '[tool_result: TeXRA (https://texra.ai), TeXRA docs (https://texra.ai/docs)]',
    );
    expect(output).not.toContain('encrypted_content');
    expect(output).not.toContain('"type":"web_search_tool_result"');
  });

  it('formats web_fetch_tool_result blocks as a title/url marker', () => {
    const output = formatConversation([
      {
        role: 'assistant',
        content: [
          {
            type: 'web_fetch_tool_result',
            tool_use_id: 'srvtoolu_2',
            content: {
              type: 'web_fetch_result',
              url: 'https://texra.ai',
              content: { type: 'document', title: 'TeXRA home' },
            },
          },
        ],
      },
    ]);

    expect(output).toContain('[tool_result: TeXRA home (https://texra.ai)]');
    expect(output).not.toContain('"type":"web_fetch_tool_result"');
  });

  it('formats archived (completed-run sidecar) web_fetch_tool_result blocks as a title/url marker', () => {
    // `src/transcript/completedRunArchive.ts`'s `webFetchEntryToMessages`
    // reconstructs this block type with top-level url/title/page_content —
    // no nested `content` — unlike the live Anthropic SDK shape above.
    const output = formatConversation([
      {
        role: 'assistant',
        content: [
          {
            type: 'web_fetch_tool_result',
            url: 'https://texra.ai',
            title: 'TeXRA home',
            page_content: 'the full fetched page text'.repeat(20),
          },
        ],
      },
    ]);

    expect(output).toContain('[tool_result: TeXRA home (https://texra.ai)]');
    expect(output).not.toContain('the full fetched page text');
  });

  it('does not emit an empty marker for a fieldless live web-fetch result', () => {
    const output = formatConversation([
      {
        role: 'assistant',
        content: [
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

    expect(output).not.toContain('[tool_result: ]');
    expect(output).toContain('web_fetch_result');
  });

  it('summarizes a content-only web-fetch result without dumping page text', () => {
    const output = formatConversation([
      {
        role: 'assistant',
        content: [
          {
            type: 'web_fetch_tool_result',
            page_content: 'fetched page text',
          },
        ],
      },
    ]);

    expect(output).toContain('[tool_result: web_fetch_result]');
    expect(output).not.toContain('fetched page text');
  });

  it('does not throw on an undefined content block', () => {
    expect(() =>
      formatConversation([{ role: 'user', content: [undefined] }]),
    ).not.toThrow();
  });

  it('defaults a missing, empty, or non-string role to "unknown"', () => {
    const output = formatConversation([
      { content: 'hi' }, // missing role
      { role: '' }, // empty role
      { role: 7 }, // non-string role
    ]);

    expect(output.match(/role="unknown"/g)).toHaveLength(3);
    expect(output).not.toContain('role=""');
    expect(output).not.toContain('role="7"');
  });
});
