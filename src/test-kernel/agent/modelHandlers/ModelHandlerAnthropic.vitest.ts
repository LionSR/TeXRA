// Node imports
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { APIUserAbortError as AnthropicUserAbortError } from '@anthropic-ai/sdk';
import { afterEach, describe, it, vi } from 'vitest';
import {
  type ModelCapabilities,
  ModelProvider,
  ReasoningEffort,
} from 'llm-zoo';

// Local imports
import { noopTrace, type AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  type AgentSetting,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandlerAnthropic } from '@agent/modelHandlers/anthropic/modelHandlerAnthropic';
import type { AnthropicToolCall } from '@agent/types/ModelHandlerContracts';
import {
  enforceCacheControlLimit,
  logContextManagementFromResponse,
  SHORT_CACHE_CONTROL,
} from '@agent/modelHandlers/anthropic/anthropicContextManagement';
import * as serverKeysModule from '@auth/serverKeys';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { setupPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { pathToLocation } from '@utils/files';
import * as configUtils from '@utils/config/configUtils';

// Third-party imports
import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';

// Real node fs is required because the prefill tests write and read files in
// os.tmpdir().
setupPlatform({}, { fs: nodeFilesystem });

afterEach(() => {
  vi.restoreAllMocks();
});

/** Stub the compaction threshold config read for compaction tests. */
function stubCompactionThresholdPercent(value: number): void {
  vi.spyOn(configUtils, 'getConfig').mockImplementation(
    <T>(path: string, defaultValue?: T): T => {
      if (path === 'texra.model.compactionThresholdPercent') {
        return value as T;
      }
      return defaultValue as T;
    },
  );
}

const ANTHROPIC_TEST_CONFIG = Object.freeze({
  name: 'test-anthropic',
  label: 'Test Anthropic',
  fullName: 'claude-test',
  shortName: 'claude-test',
  provider: ModelProvider.ANTHROPIC,
  capabilities: Object.freeze({ supportsPromptCaching: true }),
});

function createAnthropicHandler(
  capabilityOverrides: Partial<ModelCapabilities> = {},
): ModelHandlerAnthropic {
  return new ModelHandlerAnthropic(
    buildTestModelConfig(ANTHROPIC_TEST_CONFIG, {
      capabilities: capabilityOverrides,
    }),
  );
}

/** A minimal single-turn "hello" user message, the shape most tests need. */
function helloMessages(): MessageParam[] {
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello', citations: null }],
    },
  ];
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

describe('ModelHandlerAnthropic auxiliary requests', () => {
  it('restores SDK retries for tool-result uploads outside the model gate', async () => {
    const handler = createAnthropicHandler();
    handler.setLogger({ ...noopTrace });
    const upload = vi.fn(async () => ({ id: 'file-1' }));
    const uploadClient = { beta: { files: { upload } } };
    const withOptions = vi.fn(() => uploadClient);
    const call: AnthropicToolCall = {
      provider: 'anthropic',
      callId: 'call-1',
      name: 'read_file',
      input: {},
      raw: {
        id: 'call-1',
        type: 'tool_use',
        caller: { type: 'direct' },
        name: 'read_file',
        input: {},
      },
    };

    await handler.createToolUseFollowUpMessages(
      { withOptions } as never,
      call,
      { status: 'executed', output: 'done' },
      [
        {
          path: 'chart.png',
          mimeType: 'image/png',
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
    );

    assert.deepEqual(withOptions.mock.calls, [[{ maxRetries: 2 }]]);
    assert.equal(upload.mock.calls.length, 1);
  });
});

describe('ModelHandlerAnthropic forced tool choice', () => {
  it('maps finalTool to a named Anthropic tool choice', async () => {
    const handler = createAnthropicHandler();
    stubHandlerForTest(handler);
    const { client, messageOptions } = createCapturingAnthropicClient(
      handler.config.fullName,
    );

    await handler.createResponse({
      client,
      messages: helloMessages(),
      temperature: 0,
      tools: [{ name: 'submit_output', description: 'Submit output' }],
      finalTool: { name: 'submit_output' },
    });

    assert.deepEqual(messageOptions[0].tool_choice, {
      type: 'tool',
      name: 'submit_output',
    });
    assert.equal(handler.supportsForcedToolChoice, true);
  });

  it('uses the unforced floor when Anthropic thinking is enabled', async () => {
    const handler = createAnthropicHandler({ supportsReasoning: true });
    stubHandlerForTest(handler);
    const { client, messageOptions } = createCapturingAnthropicClient(
      handler.config.fullName,
    );

    await handler.createResponse({
      client,
      messages: helloMessages(),
      temperature: 0,
      tools: [{ name: 'submit_output', description: 'Submit output' }],
      finalTool: { name: 'submit_output' },
    });

    assert.deepEqual(messageOptions[0].tool_choice, { type: 'auto' });
    assert.equal(handler.supportsForcedToolChoice, false);
    assert.ok(messageOptions[0].thinking);
  });
});

/** Attach a logger stub and disable streaming for a handler under test. */
function stubHandlerForTest(
  handler: ModelHandlerAnthropic,
  loggerOverrides?: Partial<Record<string, unknown>>,
): void {
  handler.setLogger({ ...noopTrace, ...loggerOverrides } as AgentTrace);
  (handler as any).getStreamingConfig = () => false;
}

/**
 * Build a client whose beta.messages.create records each request and returns a
 * minimal successful message, capturing the recorded options for assertions.
 */
function createCapturingAnthropicClient(model: string): {
  client: any;
  messageOptions: any[];
} {
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
            model,
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    },
  } as any;
  return { client, messageOptions };
}

class PdfStubAnthropicHandler extends ModelHandlerAnthropic {
  private mediaContent: ContentBlockParam[] = [];

  setMediaContent(content: ContentBlockParam[]): void {
    this.mediaContent = content;
  }

  protected override async createMediaMessage(): Promise<any[]> {
    return this.mediaContent;
  }
}

describe('ModelHandlerAnthropic message guards', () => {
  it('includes native PDF document blocks when initializing messages', async () => {
    const handler = new PdfStubAnthropicHandler(
      buildTestModelConfig(ANTHROPIC_TEST_CONFIG, {
        capabilities: { supportsNativePdf: true },
      }),
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

  it('does not set block-level cache markers on messages (top-level automatic caching handles this)', async () => {
    const handler = createAnthropicHandler();
    const baseMessages = await handler.initializeMessages(
      'prefix',
      'initial request',
    );
    const initialContent = baseMessages[0].content as ContentBlockParam[];
    const initialBlock = initialContent.at(-1);

    assert.equal(
      getCacheMarker(initialBlock),
      undefined,
      'initial message blocks should not include block-level cache markers',
    );

    const updated = await handler.createRoundMessages(
      [...baseMessages],
      'next follow up',
    );
    const followUp = updated.at(-1)!;
    const followUpContent = followUp.content as ContentBlockParam[];
    const followUpBlock = followUpContent.at(-1);

    assert.equal(
      getCacheMarker(followUpBlock),
      undefined,
      'follow-up message blocks should not include block-level cache markers',
    );
  });

  it('does not set block-level cache markers on tool result follow-ups', async () => {
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
      { status: 'executed', output: 'ok' },
      [],
    );

    const toolResultBlock = (resultMsg.content as ContentBlockParam[])[0];
    assert.equal(
      getCacheMarker(toolResultBlock),
      undefined,
      'tool result block should not include block-level cache markers (top-level automatic caching handles this)',
    );
  });

  it('skips cache control when prompt caching is disabled', async () => {
    const handler = createAnthropicHandler({ supportsPromptCaching: false });

    const baseMessages = await handler.initializeMessages('prefix', 'request');
    const initialContent = baseMessages[0].content as ContentBlockParam[];
    const initialBlock = initialContent.at(-1);

    assert.equal(
      getCacheMarker(initialBlock),
      undefined,
      'initial message should not include cache metadata when disabled',
    );
  });

  it('strips legacy cache markers from non-compaction blocks in restored conversations', () => {
    const messageContent: ContentBlockParam[] = [];

    // Simulate a saved conversation with old-style cache_control on text blocks
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

    enforceCacheControlLimit(messages, 2, SHORT_CACHE_CONTROL, true);

    const remaining = messageContent.filter(
      (block) =>
        'cache_control' in block &&
        (block as { cache_control?: unknown }).cache_control !== undefined,
    );

    assert.equal(
      remaining.length,
      0,
      'all legacy text block cache markers should be stripped',
    );
  });

  it('preserves compaction cache markers while stripping legacy text markers', () => {
    const compactionBlock = {
      type: 'compaction',
      content: '<summary>state</summary>',
      cache_control: { type: 'ephemeral' },
    };
    const legacyTextBlock = {
      type: 'text',
      text: 'old-cached-block',
      citations: null,
      cache_control: { type: 'ephemeral' },
    } as ContentBlockParam & { cache_control: { type: 'ephemeral' } };
    const messageContent: ContentBlockParam[] = [
      legacyTextBlock,
      compactionBlock as unknown as ContentBlockParam,
      { type: 'text', text: 'block-1', citations: null },
    ];
    const messages: MessageParam[] = [
      { role: 'assistant', content: messageContent },
    ];

    enforceCacheControlLimit(messages, 2, SHORT_CACHE_CONTROL, true);

    // Legacy text marker stripped
    assert.equal(
      (legacyTextBlock as { cache_control?: unknown }).cache_control,
      undefined,
      'legacy text cache marker should be stripped',
    );

    // Compaction marker preserved
    const preservedCompaction = (messages[0].content as any[]).find(
      (block) => block.type === 'compaction',
    );
    assert.deepEqual(
      preservedCompaction?.cache_control,
      { type: 'ephemeral' },
      'compaction cache marker should remain',
    );
  });

  it('trims excess compaction markers when they exceed available slots', () => {
    const messageContent = [
      {
        type: 'compaction',
        content: '<summary>old</summary>',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'compaction',
        content: '<summary>mid</summary>',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'compaction',
        content: '<summary>new</summary>',
        cache_control: { type: 'ephemeral' },
      },
    ] as unknown as ContentBlockParam[];

    const messages: MessageParam[] = [
      { role: 'assistant', content: messageContent },
    ];

    // 2 reserved (system + automatic) → 2 available for compaction
    enforceCacheControlLimit(messages, 2, SHORT_CACHE_CONTROL, true);

    const withMarkers = (messages[0].content as any[]).filter(
      (block: any) => block.cache_control,
    );
    assert.equal(
      withMarkers.length,
      2,
      'only 2 compaction markers should remain',
    );
    assert.equal(
      (messageContent[0] as any).cache_control,
      undefined,
      'oldest compaction marker should be removed',
    );
    assert.deepEqual(
      (messageContent[2] as any).cache_control,
      { type: 'ephemeral' },
      'newest compaction marker should be preserved',
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
    stubHandlerForTest(handler);

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
    stubHandlerForTest(handler);

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
    stubHandlerForTest(handler);

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
    stubHandlerForTest(handler);

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
    stubHandlerForTest(handler);

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
    const countTokensOptions: any[] = [];

    const client = {
      beta: {
        files: {
          upload: async () => {
            callOrder.push('upload');
            return { id: 'file_uploaded' };
          },
        },
        messages: {
          countTokens: async (_params: unknown, options?: any) => {
            callOrder.push('countTokens');
            countTokensOptions.push(options);
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
    client.withOptions = vi.fn(() => client);
    const controller = new AbortController();

    const response = await handler.createResponse({
      client,
      messages,
      temperature: 0,
      signal: controller.signal,
    });

    assert.deepEqual(callOrder, ['countTokens', 'upload', 'create']);
    // Token counting retries ride per-request options, not a client clone.
    assert.deepEqual(client.withOptions.mock.calls, []);
    assert.equal(countTokensOptions[0]?.maxRetries, 2);
    assert.equal(countTokensOptions[0]?.signal, controller.signal);
    assert.equal(response.response.stop_reason, 'end_turn');
  });

  it('does not warn about context overflow for models with native 1M context', async () => {
    const handler = createAnthropicHandler({ supportsTokenCounting: true });
    handler.config.fullName = 'claude-sonnet-4-6';
    // Sonnet 4.6 ships a native 1M context window at standard pricing; the
    // window size comes straight from the llm-zoo model config (no beta
    // header), so mirror that here instead of the 200K test default.
    handler.config.contextWindow = 1_000_000;

    const warnMessages: string[] = [];
    stubHandlerForTest(handler, {
      warn: (message: string) => {
        warnMessages.push(message);
      },
    });

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
              model: 'claude-sonnet-4-6',
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
    assert.equal(response.response.stop_reason, 'end_turn');

    assert.equal(
      warnMessages.length,
      0,
      'should not warn when native 1M context window is active',
    );

    const options = messageOptions[0] ?? {};
    assert.equal(
      options.max_tokens,
      handler.config.maxOutputTokens,
      'should not reduce max_tokens below the configured value',
    );
  });

  it('adds native compaction context edit for Claude Opus 4.6 tool-use runs', async () => {
    const handler = createAnthropicHandler({
      supportsTokenCounting: false,
      supportsReasoning: false,
    });
    handler.config.fullName = 'claude-opus-4-6';
    handler.setAgentCategory(AgentCategory.ToolUse);

    stubHandlerForTest(handler);

    const messages = helloMessages();
    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-opus-4-6');

    stubCompactionThresholdPercent(75);

    await handler.createResponse({ client, messages, temperature: 0 });

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

  it('adds native compaction context edit for Claude Opus 4.8 tool-use runs', async () => {
    const handler = createAnthropicHandler({
      supportsTokenCounting: false,
      supportsReasoning: false,
    });
    handler.config.fullName = 'claude-opus-4-8';
    handler.setAgentCategory(AgentCategory.ToolUse);

    stubHandlerForTest(handler);

    const messages = helloMessages();
    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-opus-4-8');

    stubCompactionThresholdPercent(75);

    await handler.createResponse({ client, messages, temperature: 0 });

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
    assert.equal(compactionEdit.trigger?.value, 150000);
    assert.equal(compactionEdit.instructions, undefined);
  });

  it('uses adaptive thinking with xhigh effort for Opus 4.8 xhigh reasoning', async () => {
    const handler = createAnthropicHandler({
      supportsReasoning: true,
      supportsReasoningEffort: true,
      reasoningEffort: ReasoningEffort.XHIGH,
    });
    handler.config.fullName = 'claude-opus-4-8';

    stubHandlerForTest(handler);

    const messages = helloMessages();
    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-opus-4-8');

    await handler.createResponse({ client, messages, temperature: 0 });

    const options = messageOptions[0] ?? {};
    assert.deepEqual(
      options.thinking,
      { type: 'adaptive', display: 'summarized' },
      'Opus 4.8 should request adaptive thinking with display: summarized so reasoning still streams',
    );
    assert.equal(
      options.output_config?.effort,
      'xhigh',
      "xhigh reasoning effort should map to the 'xhigh' (extra) tier on Opus 4.8",
    );
  });

  it('uses adaptive thinking with max effort for Opus 4.8 max reasoning', async () => {
    const handler = createAnthropicHandler({
      supportsReasoning: true,
      supportsReasoningEffort: true,
      reasoningEffort: ReasoningEffort.MAX,
    });
    handler.config.fullName = 'claude-opus-4-8';

    stubHandlerForTest(handler);

    const messages = helloMessages();
    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-opus-4-8');

    await handler.createResponse({ client, messages, temperature: 0 });

    const options = messageOptions[0] ?? {};
    assert.equal(
      options.output_config?.effort,
      'max',
      "max reasoning effort should map to the top 'max' tier on Opus 4.8",
    );
  });

  it('uses the Anthropic minimum trigger for manual compaction requests', async () => {
    const handler = createAnthropicHandler({
      supportsTokenCounting: false,
      supportsReasoning: false,
    });
    handler.config.fullName = 'claude-opus-4-6';
    handler.setAgentCategory(AgentCategory.ToolUse);
    handler.requestCompaction();

    stubHandlerForTest(handler);

    const messages = helloMessages();
    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-opus-4-6');

    stubCompactionThresholdPercent(0);

    await handler.createResponse({ client, messages, temperature: 0 });

    const options = messageOptions[0] ?? {};
    const edits = options.context_management?.edits ?? [];
    const compactionEdit = edits.find(
      (edit: { type: string }) => edit.type === 'compact_20260112',
    );

    assert.ok(
      compactionEdit,
      'manual request should add compact_20260112 edit',
    );
    assert.equal(
      compactionEdit.trigger?.value,
      50_000,
      'manual compaction should honor Anthropic minimum trigger tokens',
    );
  });

  it('announces expected compaction after the measured count crosses the trigger', async () => {
    const handler = createAnthropicHandler({
      supportsTokenCounting: true,
      supportsReasoning: false,
    });
    handler.config.fullName = 'claude-opus-4-6';
    handler.setAgentCategory(AgentCategory.ToolUse);

    const activityStates: string[] = [];
    stubHandlerForTest(handler, {
      info: (_message: string, options?: { data?: unknown }) => {
        const data = options?.data as
          { activity?: unknown; state?: unknown } | undefined;
        if (
          data?.activity === 'context_compaction' &&
          typeof data.state === 'string'
        ) {
          activityStates.push(data.state);
        }
      },
    });
    stubCompactionThresholdPercent(75);

    const client = {
      beta: {
        messages: {
          countTokens: async () => ({ input_tokens: 160_000 }),
          create: async () => {
            assert.deepEqual(
              activityStates,
              ['started'],
              'start marker should precede the non-streaming SDK request',
            );
            return {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-4-6',
              content: [
                { type: 'compaction', content: '<summary>state</summary>' },
                { type: 'text', text: 'ok' },
              ],
              stop_reason: 'end_turn',
              usage: { input_tokens: 20_000, output_tokens: 1 },
            };
          },
        },
      },
    } as any;

    await handler.createResponse({
      client,
      messages: helloMessages(),
      temperature: 0,
    });

    assert.deepEqual(activityStates, ['started', 'finished']);
  });

  it.each([
    {
      label: 'large',
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: 'x'.repeat(620_000),
              citations: null,
            },
          ],
        },
      ],
      expectedAtRequest: ['started'],
      expectedFinal: ['started', 'finished'],
    },
    {
      label: 'small',
      messages: helloMessages(),
      expectedAtRequest: [],
      expectedFinal: [],
    },
  ])(
    'uses a fallback estimate for a $label unmeasured non-streaming request',
    async ({ messages, expectedAtRequest, expectedFinal }) => {
      const handler = createAnthropicHandler({
        supportsTokenCounting: false,
        supportsReasoning: false,
      });
      handler.config.fullName = 'claude-opus-4-6';
      handler.setAgentCategory(AgentCategory.ToolUse);

      const activityStates: string[] = [];
      stubHandlerForTest(handler, {
        info: (_message: string, options?: { data?: unknown }) => {
          const data = options?.data as
            { activity?: unknown; state?: unknown } | undefined;
          if (
            data?.activity === 'context_compaction' &&
            typeof data.state === 'string'
          ) {
            activityStates.push(data.state);
          }
        },
      });
      stubCompactionThresholdPercent(75);

      const client = {
        beta: {
          messages: {
            countTokens: async () => ({ input_tokens: 160_000 }),
            create: async () => {
              assert.deepEqual(
                activityStates,
                expectedAtRequest,
                'fallback estimate should decide before the SDK request',
              );
              return {
                id: 'msg',
                type: 'message',
                role: 'assistant',
                model: 'claude-opus-4-6',
                content: [
                  { type: 'compaction', content: '<summary>state</summary>' },
                  { type: 'text', text: 'ok' },
                ],
                stop_reason: 'end_turn',
                usage: { input_tokens: 20_000, output_tokens: 1 },
              };
            },
          },
        },
      } as any;

      await handler.createResponse({
        client,
        messages,
        temperature: 0,
      });

      assert.deepEqual(activityStates, expectedFinal);
    },
  );

  it('does not add native compaction context edit for non-Opus models', async () => {
    const handler = createAnthropicHandler({
      supportsTokenCounting: false,
      supportsReasoning: false,
    });
    handler.config.fullName = 'claude-sonnet-4-5';
    handler.setAgentCategory(AgentCategory.ToolUse);

    stubHandlerForTest(handler);

    const messages = helloMessages();
    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-sonnet-4-5');

    stubCompactionThresholdPercent(75);

    await handler.createResponse({ client, messages, temperature: 0 });

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
    const events: Array<{ message: string; data: unknown }> = [];

    const logger = {
      ...noopTrace,
      domain: (event: { key: string; text?: string; data?: unknown }) => {
        if (event.key === 'contextManagement') {
          events.push({ message: event.text ?? '', data: event.data });
        }
      },
    } as AgentTrace;

    logContextManagementFromResponse(
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
      logger,
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

/**
 * Creates a fresh temp directory with an `r0/output.xml` path for prefill
 * tests, invokes `run` with that path, and removes the directory afterward
 * regardless of outcome.
 */
async function withTempOutputPath(
  prefix: string,
  run: (outputPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outputPath = path.join(tempDir, 'r0', 'output.xml');
  try {
    await run(outputPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Build the workflow AgentSetting shared by the prefill tests. */
function createPrefillAgentSetting(): AgentSetting {
  return AgentSettingSchema.parse({
    agentCategory: AgentCategory.Workflow,
  });
}

describe('ModelHandlerAnthropic output prefill initialization', () => {
  it('writes assistant prefills for non-XML workflow outputs', async () => {
    await withTempOutputPath('anthropic-prefill-', async (outputPath) => {
      const handler = createAnthropicHandler({
        supportsAssistantPrefill: true,
      });
      stubHandlerForTest(handler);

      const agentSetting = createPrefillAgentSetting();
      const messages: MessageParam[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'revise the document' }],
        },
      ];
      const prefill = '<latex_document>';
      const workspaceState = AgentWorkspaceState.create();

      const [isComplete, updatedMessages] =
        await handler.initializeOutputAndPrefill(
          {} as AgentConfig,
          agentSetting,
          messages,
          workspaceState,
          pathToLocation(outputPath),
          prefill,
        );

      assert.equal(isComplete, false);
      assert.equal(fs.readFileSync(outputPath, 'utf8'), `${prefill}\n`);
      assert.equal(workspaceState.assembly.accumulatedOutput, `${prefill}\n`);
      assert.equal(updatedMessages.at(-1)?.role, 'assistant');
      assert.deepEqual(updatedMessages.at(-1)?.content, [
        { type: 'text', text: prefill },
      ]);
    });
  });

  it('skips assistant prefill message when prefill is empty', async () => {
    await withTempOutputPath('anthropic-prefill-empty-', async (outputPath) => {
      const handler = createAnthropicHandler({
        supportsAssistantPrefill: true,
      });
      stubHandlerForTest(handler);

      const agentSetting = createPrefillAgentSetting();
      const userMessage: MessageParam = {
        role: 'user',
        content: [{ type: 'text', text: 'revise the document' }],
      };
      const messages: MessageParam[] = [userMessage];
      const workspaceState = AgentWorkspaceState.create();

      const [isComplete, updatedMessages] =
        await handler.initializeOutputAndPrefill(
          {} as AgentConfig,
          agentSetting,
          messages,
          workspaceState,
          pathToLocation(outputPath),
          '',
        );

      assert.equal(isComplete, false);
      assert.equal(fs.existsSync(outputPath), false);
      assert.equal(workspaceState.assembly.accumulatedOutput, '');
      assert.equal(updatedMessages.length, 1);
      assert.equal(updatedMessages.at(-1)?.role, 'user');
    });
  });

  it('skips pseudo-prefill instruction when prefill is empty (thinking-only models)', async () => {
    await withTempOutputPath('anthropic-pseudo-empty-', async (outputPath) => {
      const handler = createAnthropicHandler({
        supportsAssistantPrefill: false,
      });
      stubHandlerForTest(handler);

      const agentSetting = createPrefillAgentSetting();
      const userText = 'revise the document';
      const messages: MessageParam[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: userText }],
        },
      ];
      const workspaceState = AgentWorkspaceState.create();

      const [, updatedMessages] = await handler.initializeOutputAndPrefill(
        {} as AgentConfig,
        agentSetting,
        messages,
        workspaceState,
        pathToLocation(outputPath),
        '',
      );

      assert.equal(updatedMessages.length, 1);
      const last = updatedMessages.at(-1);
      assert.equal(last?.role, 'user');
      assert.deepEqual(last?.content, [{ type: 'text', text: userText }]);
    });
  });
});

describe('ModelHandlerAnthropic updateMessageContent (prefill)', () => {
  it('creates a new assistant message when no prefill assistant turn exists', () => {
    const handler = createAnthropicHandler({ supportsAssistantPrefill: true });
    stubHandlerForTest(handler);

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'revise the document' }],
      },
    ];
    const workspaceState = AgentWorkspaceState.create();

    handler.updateMessageContent(
      messages,
      '',
      '<latex_document>...</latex_document>',
      workspaceState,
    );

    assert.equal(messages.length, 2);
    assert.equal(messages.at(-1)?.role, 'assistant');
    assert.deepEqual(messages.at(-1)?.content, [
      { type: 'text', text: '<latex_document>...</latex_document>' },
    ]);
  });

  it('appends to existing assistant prefill message', () => {
    const handler = createAnthropicHandler({ supportsAssistantPrefill: true });
    stubHandlerForTest(handler);

    const messages: MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'revise' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '<latex_document>' }],
      },
    ];
    const workspaceState = AgentWorkspaceState.create();

    handler.updateMessageContent(
      messages,
      '',
      'body</latex_document>',
      workspaceState,
    );

    assert.equal(messages.length, 2);
    const assistantContent = messages.at(-1)?.content;
    assert.equal(Array.isArray(assistantContent), true);
    assert.equal((assistantContent as MessageParam['content'])!.length, 2);
  });
});

describe('ModelHandlerAnthropic pre-message_start error handling', () => {
  /**
   * Builds a minimal stream stub that mimics the surface of the Anthropic
   * SDK's MessageStream used by ModelHandlerAnthropic.createResponse:
   *   - `.on()` for event listener registration; captures the `streamEvent`
   *     handler so the option below can simulate a real message_start event
   *   - `.controller.abort()` (no-op)
   *   - `.finalMessage()` returning a promise that rejects with `error`
   *     (after emitting message_start first, if requested)
   *   - `.currentMessage` undefined, mirroring the SDK not keeping this
   *     populated once finalMessage() has resolved/rejected
   *   - `.request_id` undefined
   */
  function buildStreamStub(
    error: unknown,
    options: { emitMessageStart?: boolean } = {},
  ): unknown {
    let streamEventHandler: ((event: unknown) => void) | undefined;
    return {
      on: (eventName: string, handler: (event: unknown) => void) => {
        if (eventName === 'streamEvent') streamEventHandler = handler;
      },
      controller: { abort: () => {} },
      finalMessage: async () => {
        if (options.emitMessageStart) {
          streamEventHandler?.({
            type: 'message_start',
            message: { id: 'msg_test123' },
          });
        }
        throw error;
      },
      currentMessage: undefined,
      request_id: undefined,
    };
  }

  it('preserves AnthropicUserAbortError thrown before message_start (does not wrap it)', async () => {
    // The stream-failure debug log resolves relay routing via the server-side
    // key service; stub it so this isolated suite doesn't need the singleton
    // that extension activation normally initializes.
    vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
      shouldUseServerSideKeysSync: () => false,
      getUseIncludedModelAccess: () => false,
      canUseServerSideKeys: async () => false,
      getRelayBaseUrl: (provider: string) =>
        `https://relay.example.com/functions/v1/relay/${provider}/v1`,
    } as unknown as ReturnType<
      typeof serverKeysModule.getServerSideKeyService
    >);

    const handler = createAnthropicHandler({
      supportsTokenCounting: false,
      supportsReasoning: false,
    });
    handler.setLogger({ ...noopTrace });
    // Force streaming path so we exercise the pre-message_start catch block.
    (handler as any).getStreamingConfig = () => true;

    const abortError = new AnthropicUserAbortError();
    const streamStub = buildStreamStub(abortError);

    const client = {
      beta: {
        messages: {
          stream: () => streamStub,
        },
      },
    } as any;

    const messages = helloMessages();

    await assert.rejects(
      handler.createResponse({ client, messages, temperature: 0 }),
      (err: unknown) => {
        // The fix under test: aborts thrown before message_start must NOT be
        // wrapped in a generic Error, otherwise downstream
        // `instanceof AnthropicUserAbortError` checks (e.g. retry classifiers)
        // would silently misclassify user aborts as generic stream failures.
        assert.ok(
          err instanceof AnthropicUserAbortError,
          `expected AnthropicUserAbortError, got ${
            err instanceof Error
              ? `${err.constructor.name}: ${err.message}`
              : String(err)
          }`,
        );
        // And the wrap-guard message must not appear for the abort path.
        assert.ok(
          !/Stream closed before message_start/.test(
            err instanceof Error ? err.message : '',
          ),
          'abort error must not be wrapped with the pre-message_start sentinel message',
        );
        return true;
      },
    );
  });

  it('preserves the original error message once message_start was received (does not mislabel a post-start stream failure)', async () => {
    vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
      shouldUseServerSideKeysSync: () => false,
      getUseIncludedModelAccess: () => false,
      canUseServerSideKeys: async () => false,
      getRelayBaseUrl: (provider: string) =>
        `https://relay.example.com/functions/v1/relay/${provider}/v1`,
    } as unknown as ReturnType<
      typeof serverKeysModule.getServerSideKeyService
    >);

    const handler = createAnthropicHandler({
      supportsTokenCounting: false,
      supportsReasoning: false,
    });
    handler.setLogger({ ...noopTrace });
    (handler as any).getStreamingConfig = () => true;

    // Simulates the message_stop guard above: message_start (and content)
    // was received, but the stream was truncated (e.g. proxy idle timeout
    // during extended thinking) before message_stop ever arrived.
    const droppedStreamError = new Error(
      'Stream ended without message_stop after 400s (462 events, ' +
        '37004 thinking chars, 0 text chars). Stream truncated, likely ' +
        'proxy idle timeout during extended thinking.',
    );
    const streamStub = buildStreamStub(droppedStreamError, {
      emitMessageStart: true,
    });

    const client = {
      beta: {
        messages: {
          stream: () => streamStub,
        },
      },
    } as any;

    const messages = helloMessages();

    await assert.rejects(
      handler.createResponse({ client, messages, temperature: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'expected an Error to be thrown');
        // The fix under test: once message_start was actually received, the
        // pre-message_start wrap guard must not fire and clobber a more
        // specific, more accurate error (previously this mislabeled the
        // message_stop-guard error as "closed before message_start", even
        // though message_start diagnostics showed it had, in fact, started).
        assert.ok(
          !/Stream closed before message_start/.test((err as Error).message),
          `expected the original message_stop-guard error to survive unwrapped, got: ${(err as Error).message}`,
        );
        assert.equal((err as Error).message, droppedStreamError.message);
        return true;
      },
    );
  });
});
