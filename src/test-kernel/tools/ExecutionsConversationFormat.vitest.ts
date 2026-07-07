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
