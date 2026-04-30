// Standard library imports
import { strict as assert } from 'assert';

// Local imports - commands
import { formatChatAsMarkdown } from '@commands/history/chatExportFormatter';

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
});
