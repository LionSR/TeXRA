import { describe, expect, it } from 'vitest';

import { formatConversation } from '@tools/executions/conversationFormat';

describe('formatConversation', () => {
  it('preserves ASCII truncation for conversation output', () => {
    const output = formatConversation([
      { kind: 'assistant-text', text: 'x'.repeat(501) },
    ]);

    expect(output).toContain(`${'x'.repeat(497)}...`);
    expect(output).not.toContain('…');
  });

  it('formats text, tool calls, and tool results', () => {
    const output = formatConversation([
      { kind: 'assistant-text', text: 'hello' },
      { kind: 'tool-call', name: 'read', input: { path: 'a.tex' } },
      { kind: 'tool-result', text: 'done' },
    ]);

    expect(output).toContain('hello');
    expect(output).toContain('[tool_use: read({"path":"a.tex"})]');
    expect(output).toContain(
      '<message index="3" role="user">\n[tool_result: done]',
    );
  });

  it('formats attachment parts as readable markers', () => {
    const output = formatConversation([
      {
        kind: 'user-message',
        parts: [
          { type: 'attachment', attachmentType: 'image' },
          { type: 'attachment', attachmentType: 'document' },
        ],
      },
    ]);

    expect(output).toContain('[image attachment]');
    expect(output).toContain('[document attachment]');
  });

  it('formats a web search as a tool_use marker and a compact result list', () => {
    const output = formatConversation([
      { kind: 'web-search', query: 'texra latex' },
      {
        kind: 'web-search-results',
        results: [
          { title: 'TeXRA', url: 'https://texra.ai' },
          { title: 'TeXRA docs', url: 'https://texra.ai/docs' },
        ],
      },
    ]);

    expect(output).toContain('[tool_use: web_search({"query":"texra latex"})]');
    expect(output).toContain(
      '[tool_result: TeXRA (https://texra.ai), TeXRA docs (https://texra.ai/docs)]',
    );
  });

  it('summarizes a web fetch as a title/url marker without the page text', () => {
    const output = formatConversation([
      {
        kind: 'web-fetch',
        url: 'https://texra.ai',
        title: 'TeXRA home',
        content: 'fetched page text',
      },
      { kind: 'web-fetch', url: 'https://texra.ai/raw' },
    ]);

    expect(output).toContain('[tool_result: TeXRA home (https://texra.ai)]');
    expect(output).toContain('[tool_result: https://texra.ai/raw]');
    expect(output).not.toContain('fetched page text');
  });
});
