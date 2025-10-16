// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';

// Local imports - agent utilities
import {
  appendTextContent,
  type MessageWithContent,
} from '@agent/modelHandlers/utils/messageContentUtils';

describe('appendTextContent', () => {
  it('promotes string content to array when appending text', () => {
    const messages = [
      { role: 'assistant', content: 'previous response' },
    ];

    appendTextContent(messages, 'assistant', [
      { type: 'text', text: 'new output' } as ChatCompletionContentPart,
    ]);

    const [assistantMessage] = messages;
    assert.ok(
      Array.isArray(assistantMessage.content),
      'expected helper to normalise string content into an array',
    );
    const content = assistantMessage
      .content as ChatCompletionContentPart[];
    assert.equal(content.length, 2);
    assert.deepEqual(content[0], {
      type: 'text',
      text: 'previous response',
    });
    assert.deepEqual(content[1], {
      type: 'text',
      text: 'new output',
    });
  });

  it('adds media parts when creating a new user message', () => {
    const messages: MessageWithContent[] = [];
    const mediaPart = {
      type: 'image_url',
      image_url: { url: 'https://example.com/image.png' },
    } as ChatCompletionContentPart;

    appendTextContent(
      messages,
      'user',
      [
        { type: 'text', text: 'prefix' } as ChatCompletionContentPart,
        mediaPart,
      ],
      { alwaysCreateNewMessage: true },
    );

    assert.equal(messages.length, 1);
    const [userMessage] = messages;
    assert.ok(
      Array.isArray(userMessage.content),
      'expected new message content to be an array',
    );
    assert.deepEqual(userMessage.content, [
      { type: 'text', text: 'prefix' },
      mediaPart,
    ]);
  });

  it('replaces existing string content when replaceExistingText is true', () => {
    const messages = [{ role: 'assistant', content: 'old text' }];
    appendTextContent(
      messages,
      'assistant',
      [{ type: 'text', text: 'new text' } as ChatCompletionContentPart],
      { replaceExistingText: true },
    );

    const content = messages[0].content as ChatCompletionContentPart[];
    assert.ok(Array.isArray(content));
    assert.equal(content.length, 1);
    assert.deepEqual(content[0], { type: 'text', text: 'new text' });
  });

  it('replaces existing array content when replaceExistingText is true', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'old text 1' },
          { type: 'text', text: 'old text 2' },
        ] as ChatCompletionContentPart[],
      },
    ];
    appendTextContent(
      messages,
      'assistant',
      [{ type: 'text', text: 'replacement' } as ChatCompletionContentPart],
      { replaceExistingText: true },
    );

    const content = messages[0].content as ChatCompletionContentPart[];
    assert.equal(content.length, 1);
    assert.deepEqual(content[0], { type: 'text', text: 'replacement' });
  });

  it('creates new message when alwaysCreateNewMessage is true despite matching role', () => {
    const messages = [{ role: 'user', content: 'first' }];
    appendTextContent(
      messages,
      'user',
      [{ type: 'text', text: 'second' } as ChatCompletionContentPart],
      { alwaysCreateNewMessage: true },
    );

    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, 'first');
    const secondContent = messages[1].content as ChatCompletionContentPart[];
    assert.deepEqual(secondContent[0], { type: 'text', text: 'second' });
  });

  it('appends to existing array content', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first part' },
        ] as ChatCompletionContentPart[],
      },
    ];
    appendTextContent(messages, 'user', [
      { type: 'text', text: 'second part' } as ChatCompletionContentPart,
    ]);

    const content = messages[0].content as ChatCompletionContentPart[];
    assert.equal(content.length, 2);
    assert.deepEqual(content[0], { type: 'text', text: 'first part' });
    assert.deepEqual(content[1], { type: 'text', text: 'second part' });
  });

  it('filters out null and undefined parts', () => {
    const messages: MessageWithContent[] = [];
    appendTextContent(messages, 'user', [
      null,
      { type: 'text', text: 'valid text' } as ChatCompletionContentPart,
      undefined,
    ]);

    const content = messages[0].content as ChatCompletionContentPart[];
    assert.equal(content.length, 1);
    assert.deepEqual(content[0], { type: 'text', text: 'valid text' });
  });

  it('handles empty parts array when appending to existing message', () => {
    const messages = [{ role: 'assistant', content: 'existing' }];
    appendTextContent(messages, 'assistant', []);

    assert.equal(messages.length, 1);
    const content = messages[0].content as ChatCompletionContentPart[];
    assert.ok(Array.isArray(content));
    assert.equal(content.length, 1);
    assert.deepEqual(content[0], { type: 'text', text: 'existing' });
  });

  it('creates empty message when parts array is empty and no existing message', () => {
    const messages: MessageWithContent[] = [];
    appendTextContent(messages, 'user', []);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.deepEqual(messages[0].content, []);
  });

  it('converts string parts to text objects', () => {
    const messages: MessageWithContent[] = [];
    appendTextContent(messages, 'user', ['simple string']);

    const content = messages[0].content as ChatCompletionContentPart[];
    assert.equal(content.length, 1);
    assert.deepEqual(content[0], { type: 'text', text: 'simple string' });
  });

  it('handles mixed string and object parts', () => {
    const messages: MessageWithContent[] = [];
    appendTextContent(messages, 'user', [
      'text string',
      { type: 'text', text: 'text object' } as ChatCompletionContentPart,
    ]);

    const content = messages[0].content as ChatCompletionContentPart[];
    assert.equal(content.length, 2);
    assert.deepEqual(content[0], { type: 'text', text: 'text string' });
    assert.deepEqual(content[1], { type: 'text', text: 'text object' });
  });

  it('creates new message when messages array is empty', () => {
    const messages: MessageWithContent[] = [];
    appendTextContent(messages, 'user', [
      { type: 'text', text: 'first message' } as ChatCompletionContentPart,
    ]);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    const content = messages[0].content as ChatCompletionContentPart[];
    assert.deepEqual(content[0], { type: 'text', text: 'first message' });
  });

  it('creates new message when last message has different role', () => {
    const messages = [{ role: 'user', content: 'user message' }];
    appendTextContent(messages, 'assistant', [
      { type: 'text', text: 'assistant message' } as ChatCompletionContentPart,
    ]);

    assert.equal(messages.length, 2);
    const assistantContent = messages[1]
      .content as ChatCompletionContentPart[];
    assert.deepEqual(assistantContent[0], {
      type: 'text',
      text: 'assistant message',
    });
  });
});
