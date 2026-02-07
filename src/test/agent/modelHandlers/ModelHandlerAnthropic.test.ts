// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { AgentCategory } from '@agent/core/AgentDataclass';
import { ModelHandlerAnthropic } from '@agent/modelHandlers/modelHandlerAnthropic';

// Type imports
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - model config
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelCapabilities,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';
import * as configModule from '@utils/config';
import { pathToLocation } from '@utils/files';

// Type imports
import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';

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

function getCacheMarker(block?: ContentBlockParam | ContentBlock): unknown {
  if (!block) {
    return undefined;
  }

  return (block as { cache_control?: unknown }).cache_control;
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
      pathToLocation('/tmp/sample.pdf'),
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
    const followUp = updated.at(-1)!;
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

  it('accumulates cache control markers on message blocks for later enforcement', async () => {
    const handler = createAnthropicHandler();
    const baseMessages = await handler.initializeMessages(
      'prefix',
      'initial request',
    );
    const initialContent = baseMessages[0].content as ContentBlockParam[];
    const initialBlock = initialContent.at(-1);
    const initialMarker = getCacheMarker(initialBlock);

    assert.ok(
      initialMarker,
      'expected the initial request to include a cache control marker',
    );

    const updated = await handler.createRoundMessages(
      [...baseMessages],
      'next follow up',
    );
    const followUp = updated.at(-1)!;
    const followUpContent = followUp.content as ContentBlockParam[];
    const followUpBlock = followUpContent.at(-1);
    const followUpMarker = getCacheMarker(followUpBlock);

    assert.ok(
      followUpMarker,
      'expected the newest message block to include a cache control marker',
    );
    assert.ok(
      getCacheMarker(initialBlock),
      'previous message should retain its cache marker (cleanup happens at API call time)',
    );
  });

  it('avoids assigning cache control to non-text media blocks', async () => {
    const handler = new PdfStubAnthropicHandler(
      buildAnthropicConfig({ supportsVision: true }),
    );

    handler.setMediaContent([
      { type: 'text', text: 'Image: diagram.png', citations: null },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'ZHVtbXk=',
        },
      },
    ] as ContentBlockParam[]);

    const messages = await handler.initializeMessages('prefix text', '', [
      pathToLocation('/tmp/diagram.png'),
    ]);

    const content = messages[0].content as ContentBlockParam[];
    const finalBlock = content.at(-1);
    assert.equal(
      finalBlock?.type,
      'image',
      'expected the final block to be an image',
    );
    assert.equal(
      getCacheMarker(finalBlock),
      undefined,
      'image block should not carry cache control metadata',
    );

    const lastTextBlock = [...content]
      .reverse()
      .find((block) => block.type === 'text');
    assert.ok(
      lastTextBlock,
      'expected at least one text block in the message content',
    );
    assert.ok(
      getCacheMarker(lastTextBlock),
      'last eligible text block should include cache control metadata',
    );
  });

  it('applies cache control to tool result follow-ups when supported', async () => {
    const handler = createAnthropicHandler();
    const call: ToolUseBlock = {
      id: 'tool-call',
      type: 'tool_use',
      name: 'demo',
      input: {},
    } as ToolUseBlock;

    const providerCall = {
      provider: 'anthropic',
      callId: call.id,
      name: call.name,
      input: call.input,
      raw: call,
    } as const;

    const [, resultMsg] = await handler.createToolUseFollowUpMessages(
      undefined,
      providerCall,
      { output: 'ok' },
      [],
    );

    const toolResultBlock = (resultMsg.content as ContentBlockParam[])[0];
    assert.ok(
      getCacheMarker(toolResultBlock),
      'tool result block should include cache control metadata',
    );
  });

  it('skips cache control when prompt caching is disabled', async () => {
    const handler = createAnthropicHandler({ supportsPromptCaching: false });
    const call: ToolUseBlock = {
      id: 'tool-call',
      type: 'tool_use',
      name: 'demo',
      input: {},
    } as ToolUseBlock;

    const baseMessages = await handler.initializeMessages('prefix', 'request');
    const initialContent = baseMessages[0].content as ContentBlockParam[];
    const initialBlock = initialContent.at(-1);

    assert.equal(
      getCacheMarker(initialBlock),
      undefined,
      'initial message should not include cache metadata when disabled',
    );

    const providerCall = {
      provider: 'anthropic',
      callId: call.id,
      name: call.name,
      input: call.input,
      raw: call,
    } as const;

    const [, resultMsg] = await handler.createToolUseFollowUpMessages(
      undefined,
      providerCall,
      { output: 'ok' },
      [],
    );

    const toolResultBlock = (resultMsg.content as ContentBlockParam[])[0];
    assert.equal(
      getCacheMarker(toolResultBlock),
      undefined,
      'tool result block should remain untouched when caching disabled',
    );
  });

  it('limits cache control markers to four evenly spaced message blocks', () => {
    const handler = createAnthropicHandler();
    const messageContent: ContentBlockParam[] = [];

    for (let idx = 0; idx < 5; idx += 1) {
      messageContent.push({
        type: 'text',
        text: `block-${idx}`,
        citations: null,
        cache_control: { type: 'ephemeral' },
      } as ContentBlockParam & { cache_control: { type: 'ephemeral' } });
    }

    const messages: MessageParam[] = [
      { role: 'user', content: messageContent },
    ];

    (handler as any).enforceCacheControlLimit(messages);

    const cacheControlledBlocks = messageContent.filter(
      (block) =>
        'cache_control' in block &&
        (block as { cache_control?: unknown }).cache_control !== undefined,
    );

    assert.equal(cacheControlledBlocks.length, 4);
    assert.equal(
      (messageContent[3] as { cache_control?: unknown }).cache_control,
      undefined,
      'the non-selected block should have its cache marker removed',
    );
    assert.deepEqual(
      cacheControlledBlocks.map((block) => (block as { text?: string }).text),
      ['block-0', 'block-1', 'block-2', 'block-4'],
      'breakpoints should be evenly spaced with the last always kept',
    );
  });

  it('distributes cache breakpoints evenly across many blocks for optimal coverage', () => {
    const handler = createAnthropicHandler();
    const messageContent: ContentBlockParam[] = [];

    for (let idx = 0; idx < 10; idx += 1) {
      messageContent.push({
        type: 'text',
        text: `block-${idx}`,
        citations: null,
        cache_control: { type: 'ephemeral' },
      } as ContentBlockParam & { cache_control: { type: 'ephemeral' } });
    }

    const messages: MessageParam[] = [
      { role: 'user', content: messageContent },
    ];

    (handler as any).enforceCacheControlLimit(messages);

    const retained = messageContent
      .filter(
        (block) =>
          'cache_control' in block &&
          (block as { cache_control?: unknown }).cache_control !== undefined,
      )
      .map((block) => (block as { text?: string }).text);

    assert.equal(retained.length, 4, 'should keep exactly 4 breakpoints');
    assert.deepEqual(
      retained,
      ['block-0', 'block-3', 'block-6', 'block-9'],
      'breakpoints should be spread across conversation for maximum cache lookback coverage',
    );
  });

  it('preserves compaction cache markers during cache control enforcement', () => {
    const handler = createAnthropicHandler();
    const compactionBlock = {
      type: 'compaction',
      content: '<summary>state</summary>',
      cache_control: { type: 'ephemeral' },
    };
    const messageContent: ContentBlockParam[] = [
      { type: 'text', text: 'block-0', citations: null },
      compactionBlock as unknown as ContentBlockParam,
      { type: 'text', text: 'block-1', citations: null },
    ];
    const messages: MessageParam[] = [
      { role: 'assistant', content: messageContent },
    ];

    (handler as any).enforceCacheControlLimit(messages);

    const preservedCompaction = (messages[0].content as any[]).find(
      (block) => block.type === 'compaction',
    );
    assert.deepEqual(
      preservedCompaction?.cache_control,
      { type: 'ephemeral' },
      'compaction cache marker should remain on replayed assistant content',
    );
  });

  it('trims follow-up text and rejects empty follow-ups', async () => {
    const handler = createAnthropicHandler();
    const baseMessages = await handler.initializeMessages('prefix', 'request');

    const withFollowUp = await handler.createUserFollowUpMessages(
      [...baseMessages],
      '  another follow up  ',
    );
    const followUp = withFollowUp.at(-1)!;
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
      streamId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      withCurrentGroup: () => undefined,
      runWithinCurrentGroup: async (fn: () => any) => fn(),
      runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
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

    const response = await handler.createResponse({
      client,
      messages,
      temperature: 0,
    });

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

    assert.equal(response.response.stop_reason, 'end_turn');
  });

  it('sanitizes uploaded PDF filenames to strip directories and forbidden characters', async () => {
    const handler = createAnthropicHandler({ supportsNativePdf: true });
    const loggerStub = {
      streamId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      withCurrentGroup: () => undefined,
      runWithinCurrentGroup: async (fn: () => any) => fn(),
      runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
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

    await handler.createResponse({ client, messages, temperature: 0 });

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
      streamId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      withCurrentGroup: () => undefined,
      runWithinCurrentGroup: async (fn: () => any) => fn(),
      runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
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

    const response = await handler.createResponse({
      client,
      messages,
      temperature: 0,
    });

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

    assert.equal(response.response.stop_reason, 'end_turn');
  });

  it('skips token counting when messages include file-based document sources', async () => {
    const handler = createAnthropicHandler({
      supportsNativePdf: true,
      supportsTokenCounting: true,
    });
    const loggerStub = {
      streamId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      withCurrentGroup: () => undefined,
      runWithinCurrentGroup: async (fn: () => any) => fn(),
      runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
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

    const response = await handler.createResponse({
      client,
      messages,
      temperature: 0,
    });

    assert.equal(
      countTokenCalls.length,
      0,
      'should skip token counting for file sources',
    );
    assert.equal(response.response.stop_reason, 'end_turn');
  });

  it('counts tokens before uploading PDF documents', async () => {
    const handler = createAnthropicHandler({
      supportsNativePdf: true,
      supportsTokenCounting: true,
    });
    const loggerStub = {
      streamId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      withCurrentGroup: () => undefined,
      runWithinCurrentGroup: async (fn: () => any) => fn(),
      runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
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

    const response = await handler.createResponse({
      client,
      messages,
      temperature: 0,
    });

    assert.deepEqual(callOrder, ['countTokens', 'upload', 'create']);
    assert.equal(response.response.stop_reason, 'end_turn');
  });

  it('does not warn about context overflow when 1M beta header is active', async () => {
    const handler = createAnthropicHandler({ supportsTokenCounting: true });
    handler.config.fullName = 'claude-sonnet-4-20250514';

    const warnMessages: string[] = [];
    const loggerStub = {
      streamId: 'test',
      debug: () => {},
      info: () => {},
      warn: (message: string) => {
        warnMessages.push(message);
      },
      error: () => {},
      fileList: () => {},
      withCurrentGroup: () => undefined,
      runWithinCurrentGroup: async (fn: () => any) => fn(),
      runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
    };
    handler.setLogger(loggerStub as unknown as AgentLogger);
    (handler as any).getStreamingConfig = () => false;

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello', citations: null },
        ] as ContentBlockParam[],
      },
    ];

    const messageOptions: any[] = [];
    const client = {
      beta: {
        messages: {
          countTokens: async () => ({ input_tokens: 900000 }),
          create: async (opts: any) => {
            messageOptions.push(opts);
            return {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-20250514',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            } as any;
          },
        },
      },
    } as any;

    const originalGetConfig = configModule.getConfig;

    try {
      (configModule as any).getConfig = (
        path: string,
        defaultValue?: unknown,
      ) => {
        if (path === 'model.useAnthropic1MBeta') {
          return true;
        }
        return defaultValue as unknown;
      };

      const response = await handler.createResponse({
        client,
        messages,
        temperature: 0,
      });
      assert.equal(response.response.stop_reason, 'end_turn');
    } finally {
      (configModule as any).getConfig = originalGetConfig;
    }

    assert.equal(
      warnMessages.length,
      0,
      'should not warn when 1M beta context window is active',
    );

    const options = messageOptions[0] ?? {};
    assert.equal(
      options.max_tokens,
      handler.config.maxOutputTokens,
      'should not reduce max_tokens below the configured value',
    );

    const betas: string[] = options.betas ?? [];
    assert.ok(
      betas.includes('context-1m-2025-08-07'),
      'should include the 1M context beta header when enabled',
    );
  });

  it('adds native compaction context edit for Claude Opus 4.6 tool-use runs', async () => {
    const handler = createAnthropicHandler({
      supportsTokenCounting: false,
      supportsReasoning: false,
    });
    handler.config.fullName = 'claude-opus-4-6';
    handler.setAgentCategory(AgentCategory.ToolUse);

    const loggerStub = {
      streamId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      withCurrentGroup: () => undefined,
      runWithinCurrentGroup: async (fn: () => any) => fn(),
      runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
      logContextManagement: () => {},
    };
    handler.setLogger(loggerStub as unknown as AgentLogger);
    (handler as any).getStreamingConfig = () => false;

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello', citations: null }],
      },
    ];
    const messageOptions: any[] = [];
    const client = {
      beta: {
        messages: {
          create: async (opts: any) => {
            messageOptions.push(opts);
            return {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-4-6',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            } as any;
          },
        },
      },
    } as any;

    const originalGetConfig = configModule.getConfig;
    try {
      (configModule as any).getConfig = (
        path: string,
        defaultValue?: unknown,
      ) => {
        if (path === 'texra.model.compactionThresholdPercent') return 75;
        return defaultValue as unknown;
      };

      await handler.createResponse({ client, messages, temperature: 0 });
    } finally {
      (configModule as any).getConfig = originalGetConfig;
    }

    const options = messageOptions[0] ?? {};
    const betas: string[] = options.betas ?? [];
    assert.ok(
      betas.includes('compact-2026-01-12'),
      'should include compaction beta header',
    );

    const edits = options.context_management?.edits ?? [];
    const compactionEdit = edits.find(
      (edit: { type: string }) => edit.type === 'compact_20260112',
    );
    assert.ok(compactionEdit, 'should configure compact_20260112 context edit');
    assert.equal(compactionEdit.pause_after_compaction, false);
    assert.equal(compactionEdit.trigger?.type, 'input_tokens');
    assert.equal(
      compactionEdit.trigger?.value,
      150000,
      'should trigger compaction at configured threshold (75%) of 200K context window',
    );
    assert.equal(
      compactionEdit.instructions,
      undefined,
      'should rely on Anthropic default compaction instructions',
    );
  });

  it('does not add native compaction context edit for non-Opus models', async () => {
    const handler = createAnthropicHandler({
      supportsTokenCounting: false,
      supportsReasoning: false,
    });
    handler.config.fullName = 'claude-sonnet-4-5';
    handler.setAgentCategory(AgentCategory.ToolUse);

    const loggerStub = {
      streamId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      withCurrentGroup: () => undefined,
      runWithinCurrentGroup: async (fn: () => any) => fn(),
      runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
      logContextManagement: () => {},
    };
    handler.setLogger(loggerStub as unknown as AgentLogger);
    (handler as any).getStreamingConfig = () => false;

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello', citations: null }],
      },
    ];
    const messageOptions: any[] = [];
    const client = {
      beta: {
        messages: {
          create: async (opts: any) => {
            messageOptions.push(opts);
            return {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-5',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            } as any;
          },
        },
      },
    } as any;

    const originalGetConfig = configModule.getConfig;
    try {
      (configModule as any).getConfig = (
        path: string,
        defaultValue?: unknown,
      ) => {
        if (path === 'texra.model.compactionThresholdPercent') return 75;
        return defaultValue as unknown;
      };

      await handler.createResponse({ client, messages, temperature: 0 });
    } finally {
      (configModule as any).getConfig = originalGetConfig;
    }

    const options = messageOptions[0] ?? {};
    const betas: string[] = options.betas ?? [];
    assert.equal(
      betas.includes('compact-2026-01-12'),
      false,
      'non-Opus models should not opt into compact beta',
    );

    const edits = options.context_management?.edits ?? [];
    const compactionEdit = edits.find(
      (edit: { type: string }) => edit.type === 'compact_20260112',
    );
    assert.equal(
      compactionEdit,
      undefined,
      'non-Opus models should not include compact_20260112 edit',
    );
  });

  it('normalizes Anthropic usage using per-iteration totals when available', () => {
    const handler = createAnthropicHandler();
    const usage = handler.normalizeUsage(
      {
        input_tokens: 111,
        output_tokens: 22,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
        server_tool_use: null,
        service_tier: 'standard',
        iterations: [
          {
            type: 'compaction',
            input_tokens: 1000,
            output_tokens: 100,
            cache_read_input_tokens: 90,
            cache_creation_input_tokens: 40,
            cache_creation: null,
          },
          {
            type: 'message',
            input_tokens: 200,
            output_tokens: 80,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
            cache_creation: null,
          },
        ],
      } as any,
      1000,
    );

    assert.equal(
      usage.inputTokens,
      1345,
      'input tokens should sum all iteration input and cache tokens',
    );
    assert.equal(
      usage.outputTokens,
      180,
      'output tokens should sum all iteration outputs',
    );
    assert.equal(
      usage.cachedInputTokens,
      100,
      'cached read tokens should come from iteration totals',
    );
    assert.equal(
      usage.cacheCreationTokens,
      45,
      'cache creation tokens should come from iteration totals',
    );
  });

  it('logs server-side compaction events from compaction blocks', () => {
    const handler = createAnthropicHandler();
    const events: Array<{ message: string; data: unknown }> = [];

    const loggerStub = {
      streamId: 'test',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fileList: () => {},
      withCurrentGroup: () => undefined,
      runWithinCurrentGroup: async (fn: () => any) => fn(),
      runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
      logContextManagement: (message: string, data: unknown) => {
        events.push({ message, data });
      },
    };
    handler.setLogger(loggerStub as unknown as AgentLogger);

    (handler as any).logContextManagementFromResponse(
      {
        content: [
          { type: 'compaction', content: '<summary>state</summary>' },
          { type: 'text', text: 'ok' },
        ],
        usage: {
          input_tokens: 24000,
          output_tokens: 1200,
          cache_read_input_tokens: 1200,
          cache_creation_input_tokens: 400,
          iterations: [
            {
              type: 'compaction',
              input_tokens: 180000,
              output_tokens: 3200,
              cache_read_input_tokens: 4000,
              cache_creation_input_tokens: 1000,
              cache_creation: null,
            },
            {
              type: 'message',
              input_tokens: 23000,
              output_tokens: 1000,
              cache_read_input_tokens: 1000,
              cache_creation_input_tokens: 200,
              cache_creation: null,
            },
          ],
        },
      } as any,
      200000,
    );

    assert.equal(
      events.length,
      1,
      'compaction block should emit one log event',
    );
    assert.match(events[0].message, /Server-side compaction/i);
    const eventData = events[0].data as {
      action: string;
      tokensBefore: number;
      tokensAfter: number;
      summary?: string;
    };
    assert.equal(eventData.action, 'compaction');
    assert.equal(eventData.tokensBefore, 185000);
    assert.equal(eventData.tokensAfter, 25600);
    assert.equal(eventData.summary, '<summary>state</summary>');
  });
});
