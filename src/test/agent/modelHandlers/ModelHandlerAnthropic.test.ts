// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages';

// Local imports - agent
import { ModelHandlerAnthropic } from '@agent/modelHandlers/modelHandlerAnthropic';
import { AgentLogger } from '@logger/AgentLogger';
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - model config
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
} from '@model/ModelConfig';

function buildAnthropicConfig(
  capabilityOverrides: Partial<ModelCapabilities> = {},
): ModelConfig {
  const capabilities = {
    ...DEFAULT_MODEL_CAPABILITIES,
    supportsPromptCaching: true,
    ...capabilityOverrides,
  };

  return {
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
}

function createAnthropicHandler(
  capabilityOverrides: Partial<ModelCapabilities> = {},
): ModelHandlerAnthropic {
  return new ModelHandlerAnthropic(buildAnthropicConfig(capabilityOverrides));
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

class PdfStubAnthropicHandler extends ModelHandlerAnthropic {
  private mediaContent: ContentBlockParam[] = [];

  setMediaContent(content: ContentBlockParam[]): void {
    this.mediaContent = content;
  }

  override async createMediaMessage(): Promise<any[]> {
    return this.mediaContent;
  }
}

describe('ModelHandlerAnthropic message guards', () => {
  it('includes native PDF document blocks when initializing messages', async () => {
    const handler = new PdfStubAnthropicHandler(
      buildAnthropicConfig({ supportsNativePdf: true }),
    );

    handler.setMediaContent([
      { type: 'text', text: 'Document: sample.pdf', citations: null },
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: 'ZHVtbXk=',
        },
        title: 'sample.pdf',
      },
    ] as ContentBlockParam[]);

    const messages = await handler.initializeMessages('', 'request text', [
      'sample.pdf',
    ]);

    const content = messages[0].content as ContentBlock[];
    const documentBlocks = (content as any[]).filter(
      (block) => block.type === 'document',
    );

    assert.equal(documentBlocks.length, 1, 'should keep document blocks');
    assert.equal(documentBlocks[0].source.type, 'base64');
    assert.equal(documentBlocks[0].title, 'sample.pdf');
  });

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

  it('uploads base64 PDF documents before creating responses', async () => {
    const handler = createAnthropicHandler({ supportsNativePdf: true });
    const loggerStub = {
      channelId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      getActiveGroupId: () => undefined,
    };
    handler.setLogger(loggerStub as unknown as AgentLogger);
    (handler as any).getStreamingConfig = () => false;

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Document: sample.pdf', citations: null },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'ZHVtbXk=',
            },
            title: 'sample.pdf',
          },
        ],
      },
    ];

    const uploadArgs: any[] = [];
    const messageOptions: any[] = [];

    const client = {
      beta: {
        files: {
          upload: async (params: any) => {
            uploadArgs.push(params);
            return { id: 'file_uploaded' };
          },
        },
        messages: {
          create: async (opts: any) => {
            messageOptions.push(opts);
            return {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: 'claude-test',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            } as any;
          },
        },
      },
    } as any;

    const response = await handler.createResponse(client, messages, 0);

    assert.equal(uploadArgs.length, 1, 'should upload the PDF document');
    assert.deepEqual(uploadArgs[0].betas, ['files-api-2025-04-14']);

    const documentBlock = (messages[0].content as any[]).find(
      (block) => block.type === 'document',
    );
    assert.ok(documentBlock, 'document block should remain in messages');
    assert.equal(documentBlock.source.type, 'file');
    assert.equal(documentBlock.source.file_id, 'file_uploaded');

    const betas: string[] = messageOptions[0].betas ?? [];
    assert.ok(
      betas.includes('files-api-2025-04-14'),
      'request should opt into the Files API beta',
    );

    assert.equal(response.stop_reason, 'end_turn');
  });

  it('sanitizes uploaded PDF filenames to strip directories and forbidden characters', async () => {
    const handler = createAnthropicHandler({ supportsNativePdf: true });
    const loggerStub = {
      channelId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      getActiveGroupId: () => undefined,
    };
    handler.setLogger(loggerStub as unknown as AgentLogger);
    (handler as any).getStreamingConfig = () => false;

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Document: nested/diagram?.pdf',
            citations: null,
          },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'ZHVtbXk=',
            },
            title: 'nested/diagram?.pdf',
          },
        ],
      },
    ];

    const uploadArgs: any[] = [];

    const client = {
      beta: {
        files: {
          upload: async (params: any) => {
            uploadArgs.push(params);
            return { id: 'file_uploaded' };
          },
        },
        messages: {
          create: async () =>
            ({
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: 'claude-test',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }) as any,
        },
      },
    } as any;

    await handler.createResponse(client, messages, 0);

    assert.equal(uploadArgs.length, 1, 'should upload the PDF document once');
    const uploadedFile = uploadArgs[0].file;
    assert.ok(uploadedFile, 'upload should include a file payload');
    assert.equal(uploadedFile.name, 'diagram_.pdf');

    const documentBlock = (messages[0].content as any[]).find(
      (block) => block.type === 'document',
    );
    assert.equal(documentBlock.title, 'nested/diagram?.pdf');
  });

  it('opts into the Files API when messages already reference uploaded PDFs', async () => {
    const handler = createAnthropicHandler({ supportsNativePdf: true });
    const loggerStub = {
      channelId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      getActiveGroupId: () => undefined,
    };
    handler.setLogger(loggerStub as unknown as AgentLogger);
    (handler as any).getStreamingConfig = () => false;

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Document: sample.pdf', citations: null },
          {
            type: 'document',
            source: {
              type: 'file',
              file_id: 'file_existing',
            },
            title: 'sample.pdf',
          },
        ] as unknown as ContentBlockParam[],
      },
    ];

    const messageOptions: any[] = [];

    const client = {
      beta: {
        files: {
          upload: async () => {
            throw new Error('should not upload when file_id already provided');
          },
        },
        messages: {
          create: async (opts: any) => {
            messageOptions.push(opts);
            return {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: 'claude-test',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            } as any;
          },
        },
      },
    } as any;

    const response = await handler.createResponse(client, messages, 0);

    const documentBlock = (messages[0].content as any[]).find(
      (block) => block.type === 'document',
    );
    assert.ok(documentBlock, 'document block should remain in messages');
    assert.equal(documentBlock.source.type, 'file');
    assert.equal(documentBlock.source.file_id, 'file_existing');

    const betas: string[] = messageOptions[0].betas ?? [];
    assert.ok(
      betas.includes('files-api-2025-04-14'),
      'request should opt into the Files API beta when referencing file IDs',
    );

    assert.equal(response.stop_reason, 'end_turn');
  });

  it('skips token counting when messages include file-based document sources', async () => {
    const handler = createAnthropicHandler({
      supportsNativePdf: true,
      supportsTokenCounting: true,
    });
    const loggerStub = {
      channelId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      getActiveGroupId: () => undefined,
    };
    handler.setLogger(loggerStub as unknown as AgentLogger);
    (handler as any).getStreamingConfig = () => false;

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Document: sample.pdf', citations: null },
          {
            type: 'document',
            source: {
              type: 'file',
              file_id: 'file_existing',
            },
            title: 'sample.pdf',
          },
        ] as unknown as ContentBlockParam[],
      },
    ];

    const countTokenCalls: string[] = [];

    const client = {
      beta: {
        files: {
          upload: async () => {
            throw new Error('should not upload existing file sources');
          },
        },
        messages: {
          countTokens: async () => {
            countTokenCalls.push('countTokens');
            throw new Error(
              'countTokens should not be invoked for file sources',
            );
          },
          create: async () =>
            ({
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: 'claude-test',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }) as any,
        },
      },
    } as any;

    const response = await handler.createResponse(client, messages, 0);

    assert.equal(
      countTokenCalls.length,
      0,
      'should skip token counting for file sources',
    );
    assert.equal(response.stop_reason, 'end_turn');
  });

  it('counts tokens before uploading PDF documents', async () => {
    const handler = createAnthropicHandler({
      supportsNativePdf: true,
      supportsTokenCounting: true,
    });
    const loggerStub = {
      channelId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      getActiveGroupId: () => undefined,
    };
    handler.setLogger(loggerStub as unknown as AgentLogger);
    (handler as any).getStreamingConfig = () => false;

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Document: sample.pdf', citations: null },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'ZHVtbXk=',
            },
            title: 'sample.pdf',
          },
        ],
      },
    ];

    const callOrder: string[] = [];

    const client = {
      beta: {
        files: {
          upload: async () => {
            callOrder.push('upload');
            return { id: 'file_uploaded' };
          },
        },
        messages: {
          countTokens: async () => {
            callOrder.push('countTokens');
            return { input_tokens: 5 } as any;
          },
          create: async () => {
            callOrder.push('create');
            return {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: 'claude-test',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            } as any;
          },
        },
      },
    } as any;

    const response = await handler.createResponse(client, messages, 0);

    assert.deepEqual(callOrder, ['countTokens', 'upload', 'create']);
    assert.equal(response.stop_reason, 'end_turn');
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
