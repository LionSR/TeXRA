// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages';

// Local imports - agent
import { ModelHandlerAnthropic } from '@agent/modelHandlers/modelHandlerAnthropic';
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - model config
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelConfig,
  ModelProvider,
} from '@model/ModelConfig';

function createAnthropicHandler(): ModelHandlerAnthropic {
  const capabilities = {
    ...DEFAULT_MODEL_CAPABILITIES,
    supportsPromptCaching: true,
  };

  const config: ModelConfig = {
    name: 'test-anthropic',
    fullName: 'claude-test',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities,
    openRouterOnly: false,
  };

  return new ModelHandlerAnthropic(config);
}

type TextBlock = Extract<ContentBlock, { type: 'text' }>;

function assertSingleTextBlock(content: ContentBlock[]): TextBlock {
  const textBlocks = content.filter(
    (block): block is TextBlock => block.type === 'text',
  );
  assert.equal(
    textBlocks.length,
    1,
    'expected exactly one text block in Anthropic message content',
  );
  return textBlocks[0];
}

describe('ModelHandlerAnthropic message guards', () => {
  it('omits whitespace-only prefix content when initializing messages', async () => {
    const handler = createAnthropicHandler();
    const messages = await handler.initializeMessages(
      '   ',
      '  request text  ',
    );

    assert.equal(messages.length, 1, 'should return a single user message');
    const content = messages[0].content as ContentBlock[];
    const textBlock = assertSingleTextBlock(content);
    assert.equal(textBlock.text, 'request text');
  });

  it('omits whitespace-only request content when initializing messages', async () => {
    const handler = createAnthropicHandler();
    const messages = await handler.initializeMessages(
      '  prefix value  ',
      '   ',
    );

    assert.equal(messages.length, 1, 'should return a single user message');
    const content = messages[0].content as ContentBlock[];
    const textBlock = assertSingleTextBlock(content);
    assert.equal(textBlock.text, 'prefix value');
  });

  it('throws when both prefix and request are empty', async () => {
    const handler = createAnthropicHandler();

    await assert.rejects(
      handler.initializeMessages('   ', '\n\t  '),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /non-empty user prefix or request/i,
          'should surface a descriptive error',
        );
        return true;
      },
    );
  });

  it('trims round message text and rejects empty content', async () => {
    const handler = createAnthropicHandler();
    const baseMessages = await handler.initializeMessages('prefix', 'request');

    const updated = await handler.createRoundMessages(
      [...baseMessages],
      '  follow up text  ',
    );
    const followUp = updated[updated.length - 1];
    const followUpContent = followUp.content as ContentBlock[];
    const textBlock = assertSingleTextBlock(followUpContent);
    assert.equal(textBlock.text, 'follow up text');

    await assert.rejects(
      handler.createRoundMessages([...baseMessages], '   '),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /non-empty content block/i);
        return true;
      },
    );
  });

  it('trims follow-up text and rejects empty follow-ups', async () => {
    const handler = createAnthropicHandler();
    const baseMessages = await handler.initializeMessages('prefix', 'request');

    const withFollowUp = await handler.createUserFollowUpMessages(
      [...baseMessages],
      '  another follow up  ',
    );
    const followUp = withFollowUp[withFollowUp.length - 1];
    const followUpContent = followUp.content as ContentBlock[];
    const textBlock = assertSingleTextBlock(followUpContent);
    assert.equal(textBlock.text, 'another follow up');

    await assert.rejects(
      handler.createUserFollowUpMessages([...baseMessages], '   '),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /non-empty user text/i);
        return true;
      },
    );
  });
});

describe('ModelHandlerAnthropic native tool extraction', () => {
  it('returns serialized native web search call when present', () => {
    const capabilities = {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsPromptCaching: true,
      supportsNativeWebSearch: true,
    };
    const config: ModelConfig = {
      name: 'test-anthropic-search',
      fullName: 'claude-test',
      provider: ModelProvider.ANTHROPIC,
      maxOutputTokens: 1024,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 200000,
      capabilities,
      openRouterOnly: false,
    };
    const handler = new ModelHandlerAnthropic(config);
    handler.setLogger(new AgentLogger('AnthropicSearch', true));

    const response = {
      content: [
        {
          type: 'tool_use',
          id: 'search-1',
          name: 'web_search',
          input: { query: 'anthropic sdk' },
        },
      ],
    } as any;

    const serialized = handler.extractToolUse(response);
    assert.ok(serialized, 'Expected serialized native tool call');
    const parsed = JSON.parse(serialized!);
    assert.equal(parsed.name, 'web_search');
    assert.equal(parsed.id, 'search-1');
  });
});
