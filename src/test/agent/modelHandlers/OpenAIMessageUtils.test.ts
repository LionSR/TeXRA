// Standard library imports
import { strict as assert } from 'assert';

// (none needed)

// Local imports - agent
import { normalizeOpenAIMessageContent } from '@agent/modelHandlers/openAIMessageUtils';

describe('normalizeOpenAIMessageContent', () => {
  it('merges consecutive roles when requested', () => {
    const first = {
      role: 'user',
      content: [{ type: 'text', text: 'first' }],
    };
    const second = {
      role: 'user',
      content: [{ type: 'text', text: 'second' }],
    };
    const third = {
      role: 'assistant',
      content: 'ready',
    };

    const normalized = normalizeOpenAIMessageContent([first, second, third], {
      mergeConsecutiveRoles: true,
    });

    assert.equal(normalized.length, 2, 'expected merged message count');
    const merged = normalized[0].content as Array<{ text: string }>;
    assert.ok(Array.isArray(merged), 'expected merged content array');
    assert.deepEqual(
      merged.map((part) => part.text),
      ['first', 'second'],
      'should append text content in order',
    );
    assert.equal(
      (normalized[1].content as string) ?? '',
      'ready',
      'assistant message should remain unchanged',
    );

    const originalFirst = first.content as Array<{ text: string }>;
    assert.equal(
      originalFirst.length,
      1,
      'original input should remain unchanged after normalization',
    );
  });

  it('converts array content to joined strings', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'alpha' },
          { type: 'text', text: 'beta' },
        ],
      },
      { role: 'assistant', content: 'ack' },
    ];

    const normalized = normalizeOpenAIMessageContent(messages, {
      convertContentToString: true,
    });

    assert.equal(normalized.length, 2);
    assert.equal(
      normalized[0].content,
      'alpha\nbeta',
      'should join text entries using newline delimiter',
    );
    assert.equal(
      normalized[1].content,
      'ack',
      'non-array content should pass through unchanged',
    );
    assert.ok(
      Array.isArray(messages[0].content),
      'input should remain an array',
    );
  });

  it('keeps media behaviour consistent when converting to strings', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image: cat.png' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,abc' },
          },
        ],
      },
    ];

    const normalized = normalizeOpenAIMessageContent(messages, {
      convertContentToString: true,
    });

    assert.equal(normalized.length, 1);
    assert.equal(
      normalized[0].content,
      'Image: cat.png',
      'should preserve text description and omit media payload similar to previous behaviour',
    );
  });

  it('preserves reasoning_content when merging consecutive assistant messages', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'first thought',
      },
      {
        role: 'assistant',
        content: 'second thought',
        reasoning_content: 'thinking step',
      },
    ];

    const normalized = normalizeOpenAIMessageContent(messages, {
      mergeConsecutiveRoles: true,
    });

    assert.equal(normalized.length, 1);
    assert.equal(
      (normalized[0] as { reasoning_content?: string }).reasoning_content,
      'thinking step',
      'reasoning_content from later message should survive merge',
    );
  });

  it('concatenates reasoning_content from both merged messages', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'first',
        reasoning_content: 'earlier reasoning',
      },
      {
        role: 'assistant',
        content: 'second',
        reasoning_content: 'later reasoning',
      },
    ];

    const normalized = normalizeOpenAIMessageContent(messages, {
      mergeConsecutiveRoles: true,
    });

    assert.equal(normalized.length, 1);
    assert.equal(
      (normalized[0] as { reasoning_content?: string }).reasoning_content,
      'earlier reasoning\nlater reasoning',
    );
  });

  it('does not merge tool-call protocol messages', () => {
    const messages = [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'first_tool', arguments: '{}' },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'second_tool', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'first result',
      },
      {
        role: 'tool',
        tool_call_id: 'call_2',
        content: 'second result',
      },
    ];

    const normalized = normalizeOpenAIMessageContent(messages, {
      mergeConsecutiveRoles: true,
      convertContentToString: true,
    });

    assert.equal(normalized.length, 3);
    assert.equal(normalized[1].tool_call_id, 'call_1');
    assert.equal(normalized[2].tool_call_id, 'call_2');
  });
});
