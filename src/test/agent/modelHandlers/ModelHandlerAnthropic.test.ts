// Standard library imports
import { strict as assert } from 'assert';

// Local imports - model handler
import { ModelHandlerAnthropic } from '@agent/modelHandlers/modelHandlerAnthropic';
import { MODEL_CONFIGS } from '@model/ModelRegistry';

function createHandler(): ModelHandlerAnthropic {
  return new ModelHandlerAnthropic(MODEL_CONFIGS['sonnet37']);
}

describe('ModelHandlerAnthropic message guards', () => {
  it('omits empty prefix text when initializing tool-use messages', async () => {
    const handler = createHandler();

    const messages = await handler.initializeMessages(
      '   ',
      '  Request content  ',
    );

    assert.strictEqual(messages.length, 1);
    const userMessage = messages[0];
    assert.strictEqual(userMessage.role, 'user');
    assert.ok(Array.isArray(userMessage.content));

    const textBlocks = (
      userMessage.content as Array<{ type: string; text?: string }>
    ).filter((block) => block.type === 'text');

    assert.strictEqual(textBlocks.length, 1);
    assert.strictEqual(textBlocks[0]?.text, '  Request content  ');
    assert.ok(textBlocks[0]?.text?.trim().length);
  });

  it('throws when both prefix and request are empty after trimming', async () => {
    const handler = createHandler();

    await assert.rejects(
      handler.initializeMessages('   ', '\n\t  '),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /requires non-empty user prefix or request/i,
        );
        return true;
      },
    );
  });

  it('skips empty text when creating follow-up round messages', async () => {
    const handler = createHandler();
    const baseMessages = await handler.initializeMessages(
      '',
      'Initial request',
    );

    const updatedMessages = await handler.createRoundMessages(
      [...baseMessages],
      '  Follow-up text  ',
    );

    const lastMessage = updatedMessages[updatedMessages.length - 1];
    assert.strictEqual(lastMessage.role, 'user');
    assert.ok(Array.isArray(lastMessage.content));

    const textBlocks = (
      lastMessage.content as Array<{ type: string; text?: string }>
    ).filter((block) => block.type === 'text');
    assert.strictEqual(textBlocks.length, 1);
    assert.strictEqual(textBlocks[0]?.text, '  Follow-up text  ');
    assert.ok(textBlocks[0]?.text?.trim().length);
  });

  it('rejects follow-up rounds that contain no text or media', async () => {
    const handler = createHandler();
    const baseMessages = await handler.initializeMessages(
      '',
      'Initial request',
    );

    await assert.rejects(
      handler.createRoundMessages([...baseMessages], '    '),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /requires non-empty text or media content/i,
        );
        return true;
      },
    );
  });

  it('rejects empty follow-up user messages', async () => {
    const handler = createHandler();
    const baseMessages = await handler.initializeMessages(
      '',
      'Initial request',
    );

    await assert.rejects(
      handler.createUserFollowUpMessages([...baseMessages], '\n\n'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /cannot be empty after trimming/i);
        return true;
      },
    );
  });
});
