// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
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
});
