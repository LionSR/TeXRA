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

  it('defaults a missing or non-string role to "unknown"', () => {
    const output = formatConversation([{ content: 'hi' }, { role: 7 }]);

    expect(output).toContain('role="unknown"');
  });
});
