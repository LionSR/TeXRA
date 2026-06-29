// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Local imports - host-neutral chat-export formatters
import { formatChatAsMarkdown } from '@agent/export/chatExportFormatter';

describe('formatChatAsMarkdown', () => {
  it('preserves function tool calls in mixed tool_calls arrays', () => {
    const markdown = formatChatAsMarkdown({
      timestamp: '2026-01-01T00:00:00.000Z',
      config: {},
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_first',
              type: 'function',
              function: {
                name: 'first_tool',
                arguments: '{"x":1}',
              },
            },
            {
              id: 'call_custom',
              type: 'custom',
              custom: {
                name: 'custom_tool',
                input: '{"skip":true}',
              },
            },
            {
              id: 'call_malformed',
              type: 'function',
            },
            {
              id: 'call_second',
              type: 'function',
              function: {
                name: 'second_tool',
                arguments: '{"y":2}',
              },
            },
          ],
        },
      ],
    });

    assert.match(markdown, /#### Tool: `first_tool`/);
    assert.match(markdown, /#### Tool: `second_tool`/);
    assert.doesNotMatch(markdown, /custom_tool/);
    assert.doesNotMatch(markdown, /call_malformed/);
  });

  it('renders OpenAI Responses function call outputs with mixed parts', () => {
    const markdown = formatChatAsMarkdown({
      timestamp: '2026-01-01T00:00:00.000Z',
      config: {},
      messages: [
        {
          type: 'function_call',
          name: 'fetch_notes',
          arguments: '{"topic":"sdk"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [
            { type: 'input_text', text: 'first line' },
            { type: 'input_text', text: '' },
            { type: 'input_image', image_url: 'https://example.com/image.png' },
            { type: 'input_file', file_id: 'file_123' },
          ],
        },
      ],
    });

    assert.match(markdown, /#### Tool: `fetch_notes`/);
    assert.match(
      markdown,
      /```\nfirst line\n\n\[image attachment]\n\[file attachment]\n```/,
    );
  });
});
