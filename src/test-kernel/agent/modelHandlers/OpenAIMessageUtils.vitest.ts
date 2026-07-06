// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - agent
import {
  insertMediaIntoChatUserMessage,
  normalizeOpenAIMessageContent,
  prependTextToChatUserMessage,
} from '@agent/modelHandlers/openai/openAIMessageUtils';

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

describe('prependTextToChatUserMessage', () => {
  it('prepends to a string user content in place', () => {
    const messages = [
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'question' },
    ];
    prependTextToChatUserMessage(messages, 'PREFIX: ');
    assert.equal(messages[1].content, 'PREFIX: question');
  });

  it('merges into the first text part of an array content', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:...' } },
          { type: 'text', text: 'body' },
        ],
      },
    ];
    prependTextToChatUserMessage(messages, 'PRE ');
    const parts = messages[0].content as Array<{ type: string; text?: string }>;
    assert.equal(parts[1].text, 'PRE body');
    assert.equal(parts.length, 2, 'no new part added when a text part exists');
  });

  it('unshifts a text part when the array has none', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:...' } }],
      },
    ];
    prependTextToChatUserMessage(messages, 'PRE');
    const parts = messages[0].content as Array<{ type: string; text?: string }>;
    assert.equal(parts.length, 2);
    assert.deepEqual(parts[0], { type: 'text', text: 'PRE' });
  });

  it('targets the last user message and ignores later assistant turns', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    prependTextToChatUserMessage(messages, 'X');
    assert.equal(messages[0].content, 'first');
    assert.equal(messages[2].content, 'Xsecond');
  });

  it('is a no-op for blank text or when no user message exists', () => {
    const blank = [{ role: 'user', content: 'unchanged' }];
    prependTextToChatUserMessage(blank, '   ');
    assert.equal(blank[0].content, 'unchanged');

    const noUser = [{ role: 'assistant', content: 'only' }];
    prependTextToChatUserMessage(noUser, 'X');
    assert.equal(noUser[0].content, 'only');
  });
});

describe('insertMediaIntoChatUserMessage', () => {
  const media = [{ type: 'image_url', image_url: { url: 'data:media' } }];

  it('promotes a string body to an array with media ahead of the text', () => {
    const message = { role: 'user', content: 'describe this' };
    insertMediaIntoChatUserMessage(message, media);
    assert.deepEqual(message.content, [
      ...media,
      { type: 'text', text: 'describe this' },
    ]);
  });

  it('unshifts media in front of existing array parts', () => {
    const message = { role: 'user', content: [{ type: 'text', text: 'body' }] };
    insertMediaIntoChatUserMessage(message, media);
    const parts = message.content as Array<{ type: string }>;
    assert.equal(parts.length, 2);
    assert.equal(parts[0].type, 'image_url');
    assert.equal(parts[1].type, 'text');
  });

  it('targets the captured message, not a later user turn', () => {
    // Regression guard: media must land on the message the caller located and
    // validated before the async formatting await, even if the conversation
    // gained another user turn meanwhile.
    const captured = { role: 'user', content: 'original' };
    const conversation = [captured, { role: 'user', content: 'newer turn' }];
    insertMediaIntoChatUserMessage(captured, media);
    assert.ok(
      Array.isArray(captured.content),
      'media should land on the captured message',
    );
    assert.equal(
      conversation[1].content,
      'newer turn',
      'a later user turn must be untouched',
    );
  });
});
