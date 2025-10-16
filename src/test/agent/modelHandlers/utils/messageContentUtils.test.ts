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
});
