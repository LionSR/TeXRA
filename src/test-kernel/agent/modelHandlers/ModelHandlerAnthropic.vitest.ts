// Node imports
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import {
  APIUserAbortError as AnthropicUserAbortError,
  BadRequestError as AnthropicBadRequestError,
} from '@anthropic-ai/sdk';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ModelCapabilities,
  MODEL_CONFIGS,
  ModelProvider,
  ReasoningEffort,
} from 'llm-zoo';

// Local imports
import { noopTrace, type AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  type AgentSetting,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandlerAnthropic } from '@agent/modelHandlers/anthropic/modelHandlerAnthropic';
import type { AnthropicToolCall } from '@agent/types/ModelHandlerContracts';
import { ANTHROPIC_STOP } from '@agent/types/StopReasonTypes';
import {
  enforceCacheControlLimit,
  logContextManagementFromResponse,
  resolveAnthropicCompactionOutcome,
  SHORT_CACHE_CONTROL,
} from '@agent/modelHandlers/anthropic/anthropicContextManagement';
import * as serverKeysModule from '@auth/serverKeys';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { AgentCategory } from '@shared/schemas';
import type { ToolFileAttachment } from '@shared/schemas/toolResult';
import { setupPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { pathToLocation } from '@utils/files/fileLocation';
import * as configUtils from '@utils/config/configUtils';

// Anthropic SDK message types
import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';

// Real node fs is required because the output-initialization tests write and
// read files in os.tmpdir().
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

/**
 * Client stand-in for follow-up tests whose calls carry no attachments, so no
 * SDK member is ever reached.
 */
const NO_UPLOAD_CLIENT = {} as never;

/** A minimal single-turn "hello" user message, the shape most tests need. */
function helloMessages(): MessageParam[] {
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello', citations: null }],
    },
  ];
}

/** The content blocks for a user turn carrying an inline base64 PDF. */
function base64PdfContent(title = 'sample.pdf'): ContentBlockParam[] {
  return [
    { type: 'text', text: `Document: ${title}`, citations: null },
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'ZHVtbXk=',
      },
      title,
    },
  ];
}

function base64PdfMessages(title = 'sample.pdf'): MessageParam[] {
  return [{ role: 'user', content: base64PdfContent(title) }];
}

/** A user turn referencing a PDF that already lives in the Files API. */
function uploadedPdfMessages(
  fileId: string,
  title = 'sample.pdf',
): MessageParam[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: `Document: ${title}`, citations: null },
        {
          type: 'document',
          source: { type: 'file', file_id: fileId },
          title,
        },
      ] as unknown as ContentBlockParam[],
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
  return (block as { cache_control?: unknown } | undefined)?.cache_control;
}

describe('ModelHandlerAnthropic.shouldContinue', () => {
  it('does not treat context-window recovery as an ordinary continuation', () => {
    const handler = createAnthropicHandler();
    handler.setLogger({ ...noopTrace });

    assert.equal(
      handler.shouldContinue(
        ANTHROPIC_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED,
        'partial response',
        {} as AgentSetting,
      ),
      false,
    );
  });
});

describe('ModelHandlerAnthropic cache pricing', () => {
  it.each([
    {
      name: 'prices cache creation by TTL breakdown when Anthropic reports it',
      cacheCreation: {
        ephemeral_5m_input_tokens: 10,
        ephemeral_1h_input_tokens: 20,
      },
      expected:
        (1000 * 3) / 1e6 +
        (100 * 15) / 1e6 +
        (10 * 3 * 1.25) / 1e6 +
        (20 * 3 * 2) / 1e6,
    },
    {
      name: 'falls back to 5-minute pricing when the TTL breakdown is absent',
      cacheCreation: {},
      expected: (1000 * 3) / 1e6 + (100 * 15) / 1e6 + (30 * 3 * 1.25) / 1e6,
    },
  ])('$name', ({ cacheCreation, expected }) => {
    const handler = new ModelHandlerAnthropic(
      buildTestModelConfig(ANTHROPIC_TEST_CONFIG, {
        inputPrice: 3,
        outputPrice: 15,
      }),
    );
    const price = handler.computePrice({
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 30,
      cache_creation: cacheCreation,
      server_tool_use: null,
      service_tier: 'standard',
    } as any);

    expect(price).toBeCloseTo(expected, 12);
  });
});

/** A minimal direct tool call for follow-up message tests. */
function createAnthropicToolCall(callId: string): AnthropicToolCall {
  return {
    provider: 'anthropic',
    callId,
    name: 'read_file',
    input: {},
    raw: {
      id: callId,
      type: 'tool_use',
      caller: { type: 'direct' },
      name: 'read_file',
      input: {},
    },
  };
}

/** A Files API client reached via withOptions, plus its upload spy. */
function createUploadClient(fileId: string): {
  upload: ReturnType<typeof vi.fn>;
  withOptions: ReturnType<typeof vi.fn>;
} {
  const upload = vi.fn(async () => ({ id: fileId }));
  const uploadClient = { beta: { files: { upload } } };
  const withOptions = vi.fn(() => uploadClient);
  return { upload, withOptions };
}

function chartAttachment(): ToolFileAttachment {
  return {
    path: 'chart.png',
    mimeType: 'image/png',
    bytes: new Uint8Array([1, 2, 3]),
  };
}

describe('ModelHandlerAnthropic auxiliary requests', () => {
  it('restores SDK retries for tool-result uploads outside the model gate', async () => {
    const handler = createAnthropicHandler();
    handler.setLogger({ ...noopTrace });
    const { upload, withOptions } = createUploadClient('file-1');

    await handler.createToolUseFollowUpMessages(
      { withOptions } as never,
      createAnthropicToolCall('call-1'),
      { status: 'executed', output: 'done' },
      [chartAttachment()],
    );

    assert.deepEqual(withOptions.mock.calls, [[{ maxRetries: 2 }]]);
    assert.equal(upload.mock.calls.length, 1);
  });

  it('uses the run-bound client for batched tool-result uploads', async () => {
    const handler = createAnthropicHandler();
    handler.setLogger({ ...noopTrace });
    const { upload, withOptions } = createUploadClient('file-batched');
    const getClient = vi
      .spyOn(handler, 'getClient')
      .mockRejectedValue(new Error('must not select another credential route'));

    await handler.createBatchedToolUseFollowUpMessages(
      [
        {
          call: createAnthropicToolCall('call-batched'),
          result: { status: 'executed', output: 'done' },
          attachments: [chartAttachment()],
        },
      ],
      undefined,
      undefined,
      { withOptions } as never,
    );

    assert.equal(getClient.mock.calls.length, 0);
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
  // getStreamingConfig is public, so this stub stays compile-checked.
  handler.getStreamingConfig = () => false;
}

/** A minimal successful Anthropic message response. */
function anthropicMessage(
  model: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
    ...overrides,
  };
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
          return anthropicMessage(model);
        },
      },
    },
  } as any;
  return { client, messageOptions };
}

/** Record `context_compaction` activity states emitted through the logger. */
function captureCompactionActivity(
  handler: ModelHandlerAnthropic,
  contextManagementEvents?: string[],
): string[] {
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
    domain: (event: { key: string; text?: string }) => {
      if (event.key === 'contextManagement' && event.text) {
        contextManagementEvents?.push(event.text);
      }
    },
  });
  return activityStates;
}

interface AnthropicFileEstimateTarget {
  uploadedPdfPageCounts: Map<string, number>;
  estimateFileReferenceTokens(
    client: unknown,
    messages: MessageParam[],
    signal?: AbortSignal,
    stopAtTokens?: number,
  ): Promise<number>;
}

function createFileEstimateHarness(...fileIds: string[]): {
  target: AnthropicFileEstimateTarget;
  messages: MessageParam[];
} {
  const handler = createAnthropicHandler({ supportsNativePdf: true });
  return {
    target: handler as unknown as AnthropicFileEstimateTarget,
    messages: [
      {
        role: 'user',
        content: fileIds.map((fileId) => ({
          type: 'document',
          source: { type: 'file', file_id: fileId },
        })) as unknown as ContentBlockParam[],
      },
    ],
  };
}

/** A Files API client stub whose retrieveMetadata only reports a byte size. */
function createSizeMetadataClient(sizeBytes = 800_000): {
  retrieveMetadata: ReturnType<typeof vi.fn>;
  client: unknown;
} {
  const retrieveMetadata = vi.fn(async () => ({ size_bytes: sizeBytes }));
  return {
    retrieveMetadata,
    client: { beta: { files: { retrieveMetadata } } },
  };
}

/** A Files API client stub for a downloadable PDF of the given bytes. */
function createPdfMetadataClient(pdfBytes: ArrayBuffer): {
  retrieveMetadata: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  client: unknown;
} {
  const retrieveMetadata = vi.fn(async () => ({
    mime_type: 'application/pdf',
    size_bytes: 800_000,
  }));
  const download = vi.fn(async () => ({
    arrayBuffer: async () => pdfBytes,
  }));
  return {
    retrieveMetadata,
    download,
    client: { beta: { files: { retrieveMetadata, download } } },
  };
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

    handler.setMediaContent(base64PdfContent());

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

  it.each([
    {
      label: 'prefix',
      prefix: '   ',
      request: '  request text  ',
      expected: 'request text',
    },
    {
      label: 'request',
      prefix: '  prefix value  ',
      request: '   ',
      expected: 'prefix value',
    },
  ])(
    'omits whitespace-only $label content when initializing messages',
    async ({ prefix, request, expected }) => {
      const handler = createAnthropicHandler();
      const messages = await handler.initializeMessages(prefix, request);

      assert.equal(messages.length, 1, 'should return a single user message');
      const textBlock = assertSingleTextBlock(
        messages[0].content as ContentBlock[],
      );
      assert.equal(textBlock.text, expected);
    },
  );

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

  it.each([
    {
      method: 'createRoundMessages',
      text: 'follow up text',
      emptyPattern: /non-empty content block/i,
    },
    {
      method: 'createUserFollowUpMessages',
      text: 'another follow up',
      emptyPattern: /non-empty user text/i,
    },
  ] as const)(
    'trims $method text and rejects empty content',
    async ({ method, text, emptyPattern }) => {
      const handler = createAnthropicHandler();
      const baseMessages = await handler.initializeMessages(
        'prefix',
        'request',
      );

      const updated = await handler[method]([...baseMessages], `  ${text}  `);
      const followUp = updated.at(-1)!;
      const textBlock = assertSingleTextBlock(
        followUp.content as ContentBlock[],
      );
      assert.equal(textBlock.text, text);

      await assert.rejects(
        handler[method]([...baseMessages], '   '),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, emptyPattern);
          return true;
        },
      );
    },
  );

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
      NO_UPLOAD_CLIENT,
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

  it('batches parallel tool results into one assistant and one user message', async () => {
    const handler = createAnthropicHandler();
    assert.equal(handler.requiresBatchedParallelToolResults, true);

    const providerCall = (id: string) =>
      ({
        provider: 'anthropic',
        callId: id,
        name: 'demo',
        input: {},
        raw: { id, type: 'tool_use', name: 'demo', input: {} } as ToolUseBlock,
      }) as const;

    const messages = await handler.createBatchedToolUseFollowUpMessages(
      [
        {
          call: providerCall('call-1'),
          result: { status: 'executed', output: 'ok-1' },
          attachments: [],
        },
        {
          call: providerCall('call-2'),
          result: { status: 'error', error: 'boom' },
          attachments: [],
        },
      ],
      undefined,
      'analysis',
      NO_UPLOAD_CLIENT,
    );

    assert.equal(messages.length, 2);
    const [callMsg, resultMsg] = messages;
    assert.equal(callMsg.role, 'assistant');
    const callContent = callMsg.content as ContentBlockParam[];
    assert.deepEqual(
      callContent.map((block) => block.type),
      ['text', 'tool_use', 'tool_use'],
    );

    assert.equal(resultMsg.role, 'user');
    const resultContent = resultMsg.content as ContentBlockParam[];
    assert.deepEqual(
      resultContent.map((block) =>
        block.type === 'tool_result'
          ? [block.tool_use_id, block.is_error]
          : block.type,
      ),
      [
        ['call-1', undefined],
        ['call-2', true],
      ],
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
});

/** Attach a files.upload stub that records its params and returns file_uploaded. */
function addCapturingUpload(client: any, uploadArgs: any[]): void {
  client.beta.files = {
    upload: async (params: any) => {
      uploadArgs.push(params);
      return { id: 'file_uploaded' };
    },
  };
}

describe('ModelHandlerAnthropic PDF uploads and token counting', () => {
  it('uploads base64 PDF documents before creating responses', async () => {
    const handler = createAnthropicHandler({ supportsNativePdf: true });
    stubHandlerForTest(handler);

    const messages = base64PdfMessages();

    const uploadArgs: any[] = [];
    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-test');
    addCapturingUpload(client, uploadArgs);

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

    const messages = base64PdfMessages('nested/diagram?.pdf');

    const uploadArgs: any[] = [];
    const { client } = createCapturingAnthropicClient('claude-test');
    addCapturingUpload(client, uploadArgs);

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

    const messages = uploadedPdfMessages('file_existing');

    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-test');
    client.beta.files = {
      upload: async () => {
        throw new Error('should not upload when file_id already provided');
      },
    };

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

    const messages = uploadedPdfMessages('file_existing');

    const countTokenCalls: string[] = [];

    const { client } = createCapturingAnthropicClient('claude-test');
    client.beta.files = {
      upload: async () => {
        throw new Error('should not upload existing file sources');
      },
    };
    client.beta.messages.countTokens = async () => {
      countTokenCalls.push('countTokens');
      throw new Error('countTokens should not be invoked for file sources');
    };

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

    const messages = base64PdfMessages();

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
            return anthropicMessage('claude-test');
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

  it('does not upload a PDF after token counting is aborted', async () => {
    const handler = createAnthropicHandler({
      supportsNativePdf: true,
      supportsTokenCounting: true,
    });
    stubHandlerForTest(handler);

    const messages = base64PdfMessages();
    const controller = new AbortController();
    const upload = vi.fn(async () => ({ id: 'file_uploaded' }));
    const create = vi.fn(async () => {
      throw new Error('should not create after abort');
    });
    const client = {
      beta: {
        files: { upload },
        messages: {
          countTokens: async () => {
            controller.abort();
            throw controller.signal.reason;
          },
          create,
        },
      },
    } as any;
    client.withOptions = vi.fn(() => client);

    await assert.rejects(
      handler.createResponse({
        client,
        messages,
        temperature: 0,
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
    assert.equal(upload.mock.calls.length, 0);
    assert.equal(create.mock.calls.length, 0);
  });
});

describe('ModelHandlerAnthropic model capabilities', () => {
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

    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-sonnet-4-6');
    client.beta.messages.countTokens = async () => ({ input_tokens: 900000 });

    const response = await handler.createResponse({
      client,
      messages: helloMessages(),
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

  it.each(['claude-opus-4-6', 'claude-opus-4-8'])(
    'adds native compaction context edit for %s tool-use runs',
    async (fullName) => {
      const handler = createCompactionEligibleHandler({ fullName });

      const messages = helloMessages();
      const { client, messageOptions } =
        createCapturingAnthropicClient(fullName);

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
      assert.ok(
        compactionEdit,
        'should configure compact_20260112 context edit',
      );
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
    },
  );

  it.each([
    { reasoningEffort: ReasoningEffort.XHIGH, expectedEffort: 'xhigh' },
    { reasoningEffort: ReasoningEffort.MAX, expectedEffort: 'max' },
  ])(
    'uses adaptive thinking with $expectedEffort effort for Opus 4.8 $expectedEffort reasoning',
    async ({ reasoningEffort, expectedEffort }) => {
      const handler = createAnthropicHandler({
        supportsReasoning: true,
        supportsReasoningEffort: true,
        supportsAdaptiveThinking: true,
        supportedReasoningEfforts: [
          ReasoningEffort.LOW,
          ReasoningEffort.MEDIUM,
          ReasoningEffort.HIGH,
          ReasoningEffort.XHIGH,
          ReasoningEffort.MAX,
        ],
        reasoningEffort,
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
        expectedEffort,
        `${expectedEffort} reasoning effort should map to the '${expectedEffort}' tier on Opus 4.8`,
      );
    },
  );

  it('uses paired Opus 5 entry capabilities instead of their shared fullName', async () => {
    const baseHandler = new ModelHandlerAnthropic(
      buildTestModelConfig(MODEL_CONFIGS.opus5, {
        capabilities: { supportsTokenCounting: false },
      }),
    );
    stubHandlerForTest(baseHandler);

    const baseCapture = createCapturingAnthropicClient('claude-opus-5');
    await baseHandler.createResponse({
      client: baseCapture.client,
      messages: helloMessages(),
      temperature: 0.7,
    });

    const baseOptions = baseCapture.messageOptions[0] ?? {};
    assert.equal(MODEL_CONFIGS.opus5.fullName, MODEL_CONFIGS.opus5T.fullName);
    assert.equal(baseOptions.thinking, undefined);
    assert.equal(baseOptions.output_config, undefined);
    assert.equal(baseOptions.temperature, 0.7);

    const handler = new ModelHandlerAnthropic(
      buildTestModelConfig(MODEL_CONFIGS.opus5T, {
        capabilities: {
          supportsTokenCounting: false,
          reasoningEffort: ReasoningEffort.XHIGH,
        },
      }),
    );
    handler.setAgentCategory(AgentCategory.ToolUse);
    stubHandlerForTest(handler);

    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-opus-5');
    stubCompactionThresholdPercent(75);

    await handler.createResponse({
      client,
      messages: helloMessages(),
      temperature: 0.7,
    });

    const options = messageOptions[0] ?? {};
    assert.equal(options.model, 'claude-opus-5');
    assert.deepEqual(options.thinking, {
      type: 'adaptive',
      display: 'summarized',
    });
    assert.equal(options.output_config?.effort, 'xhigh');
    assert.equal(options.temperature, undefined);
    assert.ok(options.betas?.includes('compact-2026-01-12'));
    assert.ok(
      options.context_management?.edits?.some(
        (edit: { type: string }) => edit.type === 'compact_20260112',
      ),
      'opus5T should be eligible for native compaction',
    );
  });

  it('maps opus5T maximum reasoning to Anthropic max effort', async () => {
    const handler = new ModelHandlerAnthropic(
      buildTestModelConfig(MODEL_CONFIGS.opus5T, {
        capabilities: {
          supportsTokenCounting: false,
          reasoningEffort: ReasoningEffort.MAX,
        },
      }),
    );
    stubHandlerForTest(handler);

    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-opus-5');
    await handler.createResponse({
      client,
      messages: helloMessages(),
      temperature: 0.7,
    });

    assert.equal(messageOptions[0]?.output_config?.effort, 'max');
    assert.equal(messageOptions[0]?.temperature, undefined);
  });
});

/**
 * A logged, non-streaming handler pinned to a given model with the compaction
 * threshold stubbed — the setup most compaction tests need.
 */
function createCompactionEligibleHandler({
  fullName = 'claude-opus-4-6',
  category = AgentCategory.ToolUse,
  capabilities = {},
  thresholdPercent = 75,
}: {
  fullName?: string;
  category?: AgentCategory;
  capabilities?: Partial<ModelCapabilities>;
  thresholdPercent?: number;
} = {}): ModelHandlerAnthropic {
  const handler = createAnthropicHandler({
    supportsTokenCounting: false,
    supportsReasoning: false,
    ...capabilities,
  });
  handler.config.fullName = fullName;
  handler.setAgentCategory(category);
  stubHandlerForTest(handler);
  stubCompactionThresholdPercent(thresholdPercent);
  return handler;
}

/**
 * A logged, non-streaming handler pinned to a compaction-capable model with
 * the compaction threshold at 0, the setup every forced-compaction test needs.
 */
function createForcedCompactionHandler(
  agentCategory: AgentCategory = AgentCategory.Workflow,
): ModelHandlerAnthropic {
  return createCompactionEligibleHandler({
    category: agentCategory,
    thresholdPercent: 0,
  });
}

describe('ModelHandlerAnthropic forced compaction', () => {
  it('round-trips forced compaction state into the next workflow invocation', async () => {
    const handler = createAnthropicHandler({
      supportsAssistantPrefill: false,
      supportsTokenCounting: false,
      supportsReasoning: false,
    });
    handler.config.fullName = 'claude-opus-4-6';
    handler.setAgentCategory(AgentCategory.Workflow);
    stubHandlerForTest(handler);
    stubCompactionThresholdPercent(0);

    const messages = helloMessages();
    const messageOptions: any[] = [];
    const responses = [
      {
        content: [{ type: 'text', text: 'partial' }],
        stop_reason: ANTHROPIC_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED,
      },
      {
        content: [
          { type: 'compaction', content: '<summary>state</summary>' },
          { type: 'text', text: 'after compaction' },
        ],
        stop_reason: ANTHROPIC_STOP.MAX_TOKENS,
      },
      {
        content: [{ type: 'text', text: 'finished' }],
        stop_reason: ANTHROPIC_STOP.END_TURN,
      },
    ];
    const client = {
      beta: {
        messages: {
          create: async (options: any) => {
            messageOptions.push(options);
            const response = responses.shift();
            assert.ok(response);
            return anthropicMessage('claude-opus-4-6', {
              id: `msg-${messageOptions.length}`,
              usage: { input_tokens: 100_000, output_tokens: 10 },
              ...response,
            });
          },
        },
      },
    } as any;
    const workspace = AgentWorkspaceState.create();
    const setting = AgentSettingSchema.parse({
      agentCategory: AgentCategory.Workflow,
    });

    const first = await handler.createResponse({
      client,
      messages,
      temperature: 0,
    });
    const firstText = handler.extractResponse(first.response, '').text;
    workspace.assembly.lastResponse = firstText;
    workspace.assembly.accumulatedOutput = firstText;
    handler.updateMessageContent(
      messages,
      '',
      firstText,
      workspace,
      first.response,
    );
    handler.requestCompaction();
    handler.addContinueMessage(messages, workspace, setting);

    const second = await handler.createResponse({
      client,
      messages,
      temperature: 0,
    });
    const secondText = handler.extractResponse(second.response, '').text;
    workspace.assembly.lastResponse = secondText;
    workspace.assembly.accumulatedOutput += secondText;
    handler.updateMessageContent(
      messages,
      '',
      secondText,
      workspace,
      second.response,
    );
    handler.addContinueMessage(messages, workspace, setting);

    await handler.createResponse({ client, messages, temperature: 0 });

    assert.equal(messageOptions[0].context_management, undefined);
    const forcedEdits = messageOptions[1].context_management?.edits ?? [];
    assert.equal(forcedEdits[0]?.type, 'compact_20260112');
    assert.equal(forcedEdits[0]?.trigger?.value, 50_000);

    const nextMessages = messageOptions[2].messages as MessageParam[];
    assert.equal(nextMessages.length, 2);
    assert.equal(nextMessages[0].role, 'assistant');
    const assistantContent = nextMessages[0].content as any[];
    assert.deepEqual(
      assistantContent.map((block) => block.type),
      ['compaction', 'text'],
    );
    assert.equal(assistantContent[0].content, '<summary>state</summary>');
    assert.equal(assistantContent[1].text, 'after compaction');
    assert.equal(
      assistantContent.filter(
        (block) => block.type === 'text' && block.text === 'after compaction',
      ).length,
      1,
    );
    assert.equal(nextMessages[1].role, 'user');
    assert.match(
      (nextMessages[1].content as Array<{ text?: string }>)[0]?.text ?? '',
      /continue responding exactly from where you left/i,
    );
    assert.equal(JSON.stringify(nextMessages).includes('partial'), false);
  });

  it('uses the last usable compaction block after an empty block', async () => {
    const handler = createCompactionEligibleHandler({
      capabilities: { supportsTokenCounting: true },
    });
    const activityStates = captureCompactionActivity(handler);
    const response = anthropicMessage('claude-opus-4-6', {
      content: [
        { type: 'compaction', content: '' },
        { type: 'compaction', content: '<summary>older</summary>' },
        { type: 'text', text: 'obsolete continuation' },
        { type: 'compaction', content: '<summary>latest</summary>' },
        { type: 'text', text: 'kept continuation' },
      ],
    });
    const client = {
      beta: {
        messages: {
          countTokens: async () => ({ input_tokens: 160_000 }),
          create: async () => response,
        },
      },
    } as any;
    const messages = helloMessages();

    await handler.createResponse({ client, messages, temperature: 0 });
    handler.updateMessageContent(
      messages,
      '',
      'obsolete continuationkept continuation',
      AgentWorkspaceState.create(),
      response,
    );

    assert.deepEqual(activityStates, ['started', 'completed']);
    assert.equal(messages.length, 1);
    const compactedContent = messages[0].content as Array<{
      type: string;
      content?: string;
      text?: string;
    }>;
    assert.deepEqual(
      compactedContent.map((block) => block.type),
      ['compaction', 'text'],
    );
    assert.equal(compactedContent[0].content, '<summary>latest</summary>');
    assert.equal(compactedContent[1].text, 'kept continuation');
    assert.equal(JSON.stringify(messages).includes('older'), false);
    assert.equal(JSON.stringify(messages).includes('obsolete'), false);
  });

  it('keeps the prior transcript when Anthropic reports a null compaction block', () => {
    const handler = createAnthropicHandler({
      supportsAssistantPrefill: false,
    });
    handler.setLogger({ ...noopTrace });
    const priorMessage: MessageParam = {
      role: 'user',
      content: [{ type: 'text', text: 'original request' }],
    };
    const messages = [priorMessage];
    const workspace = AgentWorkspaceState.create();
    workspace.assembly.accumulatedOutput = 'generated text';
    const response = {
      content: [
        { type: 'compaction', content: null },
        { type: 'text', text: 'generated text' },
      ],
    } as unknown as Parameters<
      ModelHandlerAnthropic['updateMessageContent']
    >[4];

    handler.updateMessageContent(
      messages,
      '',
      'generated text',
      workspace,
      response,
    );

    assert.equal(messages[0], priorMessage);
    assert.equal(messages.length, 2);
    assert.equal(JSON.stringify(messages).includes('original request'), true);
  });

  it('does not advertise forced compaction for unsupported Anthropic models', () => {
    const handler = createAnthropicHandler();
    handler.config.fullName = 'claude-sonnet-4-5';
    handler.setAgentCategory(AgentCategory.Workflow);

    assert.equal(handler.supportsManualCompaction, false);
  });

  it('uses the Anthropic minimum trigger for manual compaction requests', async () => {
    const handler = createForcedCompactionHandler(AgentCategory.ToolUse);
    handler.requestCompaction();

    const messages = helloMessages();
    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-opus-4-6');

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

  it('preserves forced compaction across a transient request retry', async () => {
    const handler = createForcedCompactionHandler();
    handler.requestCompaction();

    const messageOptions: any[] = [];
    const create = vi.fn(async (options: any) => {
      messageOptions.push(options);
      if (messageOptions.length === 1) {
        throw new Error('transient failure');
      }
      return anthropicMessage('claude-opus-4-6');
    });
    const client = { beta: { messages: { create } } } as any;
    const request = {
      client,
      messages: helloMessages(),
      temperature: 0,
    };

    await assert.rejects(handler.createResponse(request), /transient failure/);
    await handler.createResponse(request);
    await handler.createResponse(request);

    const firstEdits = messageOptions[0].context_management?.edits ?? [];
    const retryEdits = messageOptions[1].context_management?.edits ?? [];
    assert.equal(firstEdits[0]?.type, 'compact_20260112');
    assert.equal(retryEdits[0]?.type, 'compact_20260112');
    assert.equal(
      messageOptions[2].context_management,
      undefined,
      'forced compaction should clear after a successful response',
    );
  });

  it('preserves a newer compaction request when an older request succeeds', async () => {
    const handler = createForcedCompactionHandler();

    const messageOptions: any[] = [];
    let resolveFirstResponse: ((response: any) => void) | undefined;
    let markFirstRequestStarted: (() => void) | undefined;
    const firstRequestStarted = new Promise<void>((resolve) => {
      markFirstRequestStarted = resolve;
    });
    const firstResponse = new Promise<any>((resolve) => {
      resolveFirstResponse = resolve;
    });
    const successfulResponse = anthropicMessage('claude-opus-4-6');
    const create = vi.fn(async (options: any) => {
      messageOptions.push(options);
      if (messageOptions.length === 1) {
        markFirstRequestStarted?.();
        return firstResponse;
      }
      return successfulResponse;
    });
    const client = { beta: { messages: { create } } } as any;
    const request = {
      client,
      messages: helloMessages(),
      temperature: 0,
    };

    handler.requestCompaction();
    const inFlight = handler.createResponse(request);
    await firstRequestStarted;
    handler.requestCompaction();
    resolveFirstResponse?.(successfulResponse);
    await inFlight;
    await handler.createResponse(request);

    const firstEdits = messageOptions[0].context_management?.edits ?? [];
    const nextEdits = messageOptions[1].context_management?.edits ?? [];
    assert.equal(firstEdits[0]?.type, 'compact_20260112');
    assert.equal(nextEdits[0]?.type, 'compact_20260112');
  });

  it('does not leak an abandoned forced compaction into a later call', async () => {
    const handler = createForcedCompactionHandler();

    const abandonedRequestId = handler.requestCompaction();
    handler.clearCompactionRequest(abandonedRequestId);
    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-opus-4-6');

    await handler.createResponse({
      client,
      messages: helloMessages(),
      temperature: 0,
    });

    assert.equal(messageOptions[0].context_management, undefined);
  });

  it('does not let an older recovery clear a newer compaction request', async () => {
    const handler = createForcedCompactionHandler();

    const abandonedRequestId = handler.requestCompaction();
    handler.requestCompaction();
    handler.clearCompactionRequest(abandonedRequestId);
    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-opus-4-6');

    await handler.createResponse({
      client,
      messages: helloMessages(),
      temperature: 0,
    });

    const edits = messageOptions[0].context_management?.edits ?? [];
    assert.equal(edits[0]?.type, 'compact_20260112');
  });

  it('announces expected compaction after the measured count crosses the trigger', async () => {
    const handler = createCompactionEligibleHandler({
      capabilities: { supportsTokenCounting: true },
    });
    const activityStates = captureCompactionActivity(handler);

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
            return anthropicMessage('claude-opus-4-6', {
              content: [
                { type: 'compaction', content: '<summary>state</summary>' },
                { type: 'text', text: 'ok' },
              ],
              usage: { input_tokens: 20_000, output_tokens: 1 },
            });
          },
        },
      },
    } as any;

    await handler.createResponse({
      client,
      messages: helloMessages(),
      temperature: 0,
    });

    assert.deepEqual(activityStates, ['started', 'completed']);
  });

  it.each([null, '', ' \n'])(
    'marks non-streaming compaction content %j as skipped',
    async (content) => {
      const handler = createCompactionEligibleHandler({
        capabilities: { supportsTokenCounting: true },
      });
      const contextManagementEvents: string[] = [];
      const activityStates = captureCompactionActivity(
        handler,
        contextManagementEvents,
      );
      const client = {
        beta: {
          messages: {
            countTokens: async () => ({ input_tokens: 160_000 }),
            create: async () =>
              anthropicMessage('claude-opus-4-6', {
                content: [
                  { type: 'compaction', content },
                  { type: 'text', text: 'ok' },
                ],
              }),
          },
        },
      } as any;

      await handler.createResponse({
        client,
        messages: helloMessages(),
        temperature: 0,
      });

      assert.deepEqual(activityStates, ['started', 'skipped']);
      assert.deepEqual(contextManagementEvents, []);
    },
  );

  it.each(['', ' \n'])(
    'records below-threshold unexpected compaction content %j as one skipped lifecycle',
    async (content) => {
      const handler = createCompactionEligibleHandler({
        capabilities: { supportsTokenCounting: true },
      });
      const contextManagementEvents: string[] = [];
      const activityStates = captureCompactionActivity(
        handler,
        contextManagementEvents,
      );
      const client = {
        beta: {
          messages: {
            countTokens: async () => ({ input_tokens: 1 }),
            create: async () =>
              anthropicMessage('claude-opus-4-6', {
                content: [
                  { type: 'compaction', content },
                  { type: 'text', text: 'ok' },
                ],
              }),
          },
        },
      } as any;

      await handler.createResponse({
        client,
        messages: helloMessages(),
        temperature: 0,
      });

      assert.deepEqual(activityStates, ['started', 'skipped']);
      assert.deepEqual(contextManagementEvents, []);
    },
  );

  /** A streaming client that emits one compaction content-block start, then resolves to the given message. */
  function streamingCompactionClient(
    model: string,
    content: unknown,
    requestId: string,
  ): { client: any } {
    const response = anthropicMessage(model, {
      content: [
        { type: 'compaction', content },
        { type: 'text', text: 'ok' },
      ],
    });
    let streamEventHandler: ((event: unknown) => void) | undefined;
    const client = {
      beta: {
        messages: {
          stream: () => ({
            on: (eventName: string, callback: (event: unknown) => void) => {
              if (eventName === 'streamEvent') streamEventHandler = callback;
            },
            controller: { abort: () => {} },
            finalMessage: async () => {
              streamEventHandler?.({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'compaction', content: '' },
              });
              return response;
            },
            currentMessage: response,
            request_id: requestId,
          }),
        },
      },
    } as any;
    return { client };
  }

  it('uses the final streaming response as the canonical compaction outcome', async () => {
    const handler = createAnthropicHandler({
      supportsTokenCounting: false,
      supportsReasoning: false,
    });
    const activityEvents: Array<{
      activity: string;
      operationId: string;
      state: string;
    }> = [];
    const contextManagementEvents: string[] = [];
    handler.setLogger({
      ...noopTrace,
      info: (_message, options) => {
        const data = options?.data as
          (typeof activityEvents)[number] | undefined;
        if (data?.activity === 'context_compaction') activityEvents.push(data);
      },
      domain: (event) => {
        if (event.key === 'contextManagement' && event.text) {
          contextManagementEvents.push(event.text);
        }
      },
    });
    handler.getStreamingConfig = () => true;
    const { client } = streamingCompactionClient(
      handler.config.fullName,
      'usable summary',
      'req_compaction',
    );

    await handler.createResponse({
      client,
      messages: helloMessages(),
      temperature: 0,
    });

    assert.deepEqual(
      activityEvents.map(({ state }) => state),
      ['started', 'completed'],
    );
    assert.equal(
      activityEvents[0]?.operationId,
      activityEvents[1]?.operationId,
    );
    assert.equal(contextManagementEvents.length, 1);
  });

  it.each([null, '', ' \n'])(
    'does not report summarized context for streaming compaction content %j',
    async (content) => {
      const handler = createAnthropicHandler({
        supportsTokenCounting: false,
        supportsReasoning: false,
      });
      const contextManagementEvents: string[] = [];
      const activityStates = captureCompactionActivity(
        handler,
        contextManagementEvents,
      );
      handler.getStreamingConfig = () => true;
      const { client } = streamingCompactionClient(
        handler.config.fullName,
        content,
        'req_compaction_skipped',
      );

      await handler.createResponse({
        client,
        messages: helloMessages(),
        temperature: 0,
      });

      assert.deepEqual(activityStates, ['started', 'skipped']);
      assert.deepEqual(contextManagementEvents, []);
    },
  );
});

describe('ModelHandlerAnthropic file-reference token estimation', () => {
  it('drops compacted file metadata before estimating later requests', async () => {
    const handler = createCompactionEligibleHandler({
      capabilities: { supportsNativePdf: true },
    });

    const pdf = await PDFDocument.create();
    pdf.addPage();
    const pdfData = Buffer.from(await pdf.save()).toString('base64');
    const initialMessages: MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfData,
            },
            title: 'uploaded.pdf',
          },
          {
            type: 'document',
            source: { type: 'file', file_id: 'file_estimated' },
            title: 'estimated.txt',
          },
        ] as unknown as ContentBlockParam[],
      },
    ];
    const retrieveMetadata = vi.fn(async (_fileId: string) => ({
      mime_type: 'text/plain',
      size_bytes: 4_000,
    }));
    const { client } = createCapturingAnthropicClient('claude-opus-4-6');
    client.beta.files = {
      upload: vi.fn(async () => ({ id: 'file_uploaded' })),
      retrieveMetadata,
    };

    await handler.createResponse({
      client,
      messages: initialMessages,
      temperature: 0,
    });
    expect(retrieveMetadata.mock.calls.map(([fileId]) => fileId)).toEqual([
      'file_estimated',
    ]);

    await handler.createResponse({
      client,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'compaction', content: '<summary>state</summary>' },
          ] as unknown as ContentBlockParam[],
        },
        ...helloMessages(),
      ],
      temperature: 0,
    });

    await handler.createResponse({
      client,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'file', file_id: 'file_uploaded' },
            },
            {
              type: 'document',
              source: { type: 'file', file_id: 'file_estimated' },
            },
          ] as unknown as ContentBlockParam[],
        },
      ],
      temperature: 0,
    });

    expect(retrieveMetadata.mock.calls.map(([fileId]) => fileId)).toEqual([
      'file_estimated',
      'file_uploaded',
      'file_estimated',
    ]);
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
      trackedPdfPages: 0,
      expectedAtRequest: ['started'],
      expectedFinal: ['started', 'completed'],
    },
    {
      label: 'file-backed',
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document' as const,
              source: {
                type: 'file' as const,
                file_id: 'file_existing',
              },
              title: 'sample.pdf',
            } as unknown as ContentBlockParam,
          ],
        },
      ],
      trackedPdfPages: 50,
      expectedAtRequest: ['started'],
      expectedFinal: ['started', 'completed'],
    },
    {
      label: 'small',
      messages: helloMessages(),
      trackedPdfPages: 0,
      expectedAtRequest: [],
      expectedFinal: ['started', 'completed'],
    },
  ])(
    'uses a fallback estimate for a $label unmeasured non-streaming request',
    async ({ messages, trackedPdfPages, expectedAtRequest, expectedFinal }) => {
      const handler = createCompactionEligibleHandler({
        capabilities: { supportsNativePdf: true },
      });
      if (trackedPdfPages > 0) {
        (handler as any).uploadedPdfPageCounts.set(
          'file_existing',
          trackedPdfPages,
        );
      }

      const activityStates = captureCompactionActivity(handler);

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
              return anthropicMessage('claude-opus-4-6', {
                content: [
                  { type: 'compaction', content: '<summary>state</summary>' },
                  { type: 'text', text: 'ok' },
                ],
                usage: { input_tokens: 20_000, output_tokens: 1 },
              });
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

  it('skips file metadata after text already crosses the trigger', async () => {
    const handler = createCompactionEligibleHandler({
      capabilities: { supportsNativePdf: true },
    });

    const retrieveMetadata = vi.fn(async (_fileId: string) => ({
      size_bytes: 800_000,
    }));
    const { client } = createCapturingAnthropicClient('claude-opus-4-6');
    client.beta.files = { retrieveMetadata };
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'x'.repeat(620_000), citations: null },
          {
            type: 'document',
            source: { type: 'file', file_id: 'file_unneeded' },
          },
        ] as unknown as ContentBlockParam[],
      },
    ];

    await handler.createResponse({ client, messages, temperature: 0 });

    assert.equal(retrieveMetadata.mock.calls.length, 0);
  });

  it('includes Files API document size in the unmeasured fallback', async () => {
    const handler = createCompactionEligibleHandler({
      capabilities: { supportsNativePdf: true, supportsTokenCounting: true },
    });
    const activityStates = captureCompactionActivity(handler);

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Review this document.', citations: null },
          {
            type: 'document',
            source: { type: 'file', file_id: 'file_large' },
            title: 'large.pdf',
          },
        ] as unknown as ContentBlockParam[],
      },
    ];
    const client = {
      beta: {
        files: {
          retrieveMetadata: async (
            fileId: string,
            _params: unknown,
            options: { maxRetries?: number },
          ) => {
            assert.equal(fileId, 'file_large');
            assert.equal(options.maxRetries, 0);
            return { size_bytes: 800_000 };
          },
        },
        messages: {
          countTokens: async () => {
            throw new Error('file-source requests must not use countTokens');
          },
          create: async () => {
            assert.deepEqual(activityStates, ['started']);
            return anthropicMessage('claude-opus-4-6', {
              usage: { input_tokens: 20_000, output_tokens: 1 },
            });
          },
        },
      },
    } as any;

    await handler.createResponse({ client, messages, temperature: 0 });

    assert.deepEqual(activityStates, ['started', 'skipped']);
  });

  it('recovers PDF page estimates for resumed file references', async () => {
    const { target, messages } = createFileEstimateHarness('file_resumed_pdf');
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const pdfBytes = Uint8Array.from(await pdf.save());
    const { retrieveMetadata, download, client } = createPdfMetadataClient(
      pdfBytes.buffer,
    );

    const firstEstimate = await target.estimateFileReferenceTokens(
      client,
      messages,
    );
    const cachedEstimate = await target.estimateFileReferenceTokens(
      client,
      messages,
    );

    assert.equal(firstEstimate, 3_000);
    assert.equal(cachedEstimate, 3_000);
    assert.equal(retrieveMetadata.mock.calls.length, 1);
    assert.equal(download.mock.calls.length, 1);
  });

  it('caches a size fallback when a resumed PDF cannot be parsed', async () => {
    const { target, messages } = createFileEstimateHarness('file_invalid_pdf');
    const { retrieveMetadata, download, client } = createPdfMetadataClient(
      new TextEncoder().encode('not a PDF').buffer,
    );

    const firstEstimate = await target.estimateFileReferenceTokens(
      client,
      messages,
    );
    const cachedEstimate = await target.estimateFileReferenceTokens(
      client,
      messages,
    );

    assert.equal(firstEstimate, 200_000);
    assert.equal(cachedEstimate, 200_000);
    assert.equal(retrieveMetadata.mock.calls.length, 1);
    assert.equal(download.mock.calls.length, 1);
  });

  it('uses metadata without downloading a large resumed PDF', async () => {
    const { target, messages } = createFileEstimateHarness('file_large_pdf');
    const retrieveMetadata = vi.fn(async () => ({
      mime_type: 'application/pdf',
      size_bytes: 2 * 1024 * 1024,
    }));
    const download = vi.fn();
    const client = { beta: { files: { retrieveMetadata, download } } };

    const firstEstimate = await target.estimateFileReferenceTokens(
      client,
      messages,
    );
    const cachedEstimate = await target.estimateFileReferenceTokens(
      client,
      messages,
    );

    assert.equal(firstEstimate, 512 * 1024);
    assert.equal(cachedEstimate, 512 * 1024);
    assert.equal(retrieveMetadata.mock.calls.length, 1);
    assert.equal(download.mock.calls.length, 0);
  });

  it('prefers tracked PDF pages over compressed file size', async () => {
    const { target, messages } = createFileEstimateHarness(
      'file_tracked',
      'file_tracked',
    );
    target.uploadedPdfPageCounts.set('file_tracked', 1);
    const { retrieveMetadata, client } = createSizeMetadataClient();

    const estimate = await target.estimateFileReferenceTokens(client, messages);

    assert.equal(estimate, 6_000);
    assert.equal(retrieveMetadata.mock.calls.length, 0);
  });

  it('counts repeated file references while caching their metadata', async () => {
    const { target, messages } = createFileEstimateHarness(
      'file_repeated',
      'file_repeated',
    );
    const { retrieveMetadata, client } = createSizeMetadataClient();

    const estimate = await target.estimateFileReferenceTokens(client, messages);

    assert.equal(estimate, 400_000);
    assert.equal(retrieveMetadata.mock.calls.length, 1);
  });

  it('ignores file references before the latest compaction boundary', async () => {
    const { target } = createFileEstimateHarness();
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'file', file_id: 'file_compacted' },
          },
        ] as unknown as ContentBlockParam[],
      },
      {
        role: 'assistant',
        content: [
          { type: 'compaction', content: '<summary>state</summary>' },
        ] as unknown as ContentBlockParam[],
      },
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'file', file_id: 'file_live' },
          },
        ] as unknown as ContentBlockParam[],
      },
    ];
    const { retrieveMetadata, client } = createSizeMetadataClient();

    const estimate = await target.estimateFileReferenceTokens(client, messages);

    assert.equal(estimate, 200_000);
    assert.equal(retrieveMetadata.mock.calls.length, 1);
    assert.equal(retrieveMetadata.mock.calls[0]?.[0], 'file_live');
  });

  it('stops metadata lookups once file estimates cross the trigger', async () => {
    const { target, messages } = createFileEstimateHarness(
      'file_first',
      'file_unneeded',
    );
    const { retrieveMetadata, client } = createSizeMetadataClient();

    const estimate = await target.estimateFileReferenceTokens(
      client,
      messages,
      undefined,
      100_000,
    );

    assert.equal(estimate, 200_000);
    assert.equal(retrieveMetadata.mock.calls.length, 1);
    assert.equal(retrieveMetadata.mock.calls[0]?.[0], 'file_first');
  });

  it('stops file metadata estimation immediately after cancellation', async () => {
    const { target, messages } = createFileEstimateHarness('first', 'second');
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    const retrieveMetadata = vi.fn(async () => {
      controller.abort(reason);
      throw reason;
    });

    await assert.rejects(
      target.estimateFileReferenceTokens(
        { beta: { files: { retrieveMetadata } } },
        messages,
        controller.signal,
      ),
      reason,
    );
    assert.equal(retrieveMetadata.mock.calls.length, 1);
  });
});

describe('ModelHandlerAnthropic usage and server-side compaction reporting', () => {
  it('does not add native compaction context edit for non-Opus models', async () => {
    const handler = createCompactionEligibleHandler({
      fullName: 'claude-sonnet-4-5',
    });

    const messages = helloMessages();
    const { client, messageOptions } =
      createCapturingAnthropicClient('claude-sonnet-4-5');

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

  it('logs the summary and statistics from the last usable compaction boundary', () => {
    const events: Array<{ message: string; data: unknown }> = [];
    const logger = {
      ...noopTrace,
      domain: (event: { key: string; text?: string; data?: unknown }) => {
        if (event.key === 'contextManagement') {
          events.push({ message: event.text ?? '', data: event.data });
        }
      },
    } as AgentTrace;
    const response = {
      content: [
        { type: 'compaction', content: '<summary>older</summary>' },
        { type: 'text', text: 'intermediate' },
        { type: 'compaction', content: '<summary>latest</summary>' },
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
            input_tokens: 120000,
            output_tokens: 2000,
            cache_read_input_tokens: 3000,
            cache_creation_input_tokens: 500,
            cache_creation: null,
          },
          {
            type: 'compaction',
            input_tokens: 90000,
            output_tokens: 1600,
            cache_read_input_tokens: 2500,
            cache_creation_input_tokens: 500,
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
    } as any;
    const outcome = resolveAnthropicCompactionOutcome(response);
    assert.ok(outcome?.state === 'completed');

    logContextManagementFromResponse(response, outcome, 200000, logger);

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
    assert.equal(eventData.tokensBefore, 93000);
    assert.equal(eventData.tokensAfter, 25600);
    assert.equal(eventData.summary, '<summary>latest</summary>');
  });
});

/**
 * Creates a fresh temp directory with an `r0/output.xml` path for output
 * initialization tests, invokes `run` with that path, and removes the
 * directory afterward regardless of outcome.
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

/** Build the workflow AgentSetting shared by the output initialization tests. */
function createOutputInitAgentSetting(): AgentSetting {
  return AgentSettingSchema.parse({
    agentCategory: AgentCategory.Workflow,
  });
}

describe('ModelHandlerAnthropic output initialization', () => {
  it('leaves messages untouched when no output file exists', async () => {
    await withTempOutputPath('anthropic-output-init-', async (outputPath) => {
      const handler = createAnthropicHandler({
        supportsAssistantPrefill: true,
      });
      stubHandlerForTest(handler);

      const agentSetting = createOutputInitAgentSetting();
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
        );

      assert.equal(isComplete, false);
      assert.equal(fs.existsSync(outputPath), false);
      assert.equal(workspaceState.assembly.accumulatedOutput, '');
      assert.equal(updatedMessages.length, 1);
      assert.equal(updatedMessages.at(-1)?.role, 'user');
    });
  });

  it('leaves messages untouched for models without assistant prefill', async () => {
    await withTempOutputPath('anthropic-no-prefill-', async (outputPath) => {
      const handler = createAnthropicHandler({
        supportsAssistantPrefill: false,
      });
      stubHandlerForTest(handler);

      const agentSetting = createOutputInitAgentSetting();
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

  /**
   * The stream-failure debug log resolves relay routing via the server-side
   * key service; stub it so this isolated suite doesn't need the singleton
   * that extension activation normally initializes.
   */
  function stubDirectServerKeyService(): void {
    vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
      shouldUseServerSideKeysSync: () => false,
      getUseIncludedModelAccess: () => false,
      canUseServerSideKeys: async () => false,
      getRelayBaseUrl: (provider: string) =>
        `https://relay.example.com/functions/v1/relay/${provider}/v1`,
    } as unknown as ReturnType<
      typeof serverKeysModule.getServerSideKeyService
    >);
  }

  beforeEach(stubDirectServerKeyService);

  /**
   * A logged handler forced onto the streaming path so tests exercise the
   * pre-message_start catch block.
   */
  function createStreamingHandler(logger?: AgentTrace): ModelHandlerAnthropic {
    const handler = createAnthropicHandler({
      supportsTokenCounting: false,
      supportsReasoning: false,
    });
    handler.setLogger(logger ?? { ...noopTrace });
    handler.getStreamingConfig = () => true;
    return handler;
  }

  function streamClientOf(streamStub: unknown): any {
    return { beta: { messages: { stream: () => streamStub } } } as any;
  }

  it('preserves AnthropicUserAbortError thrown before message_start (does not wrap it)', async () => {
    const handler = createStreamingHandler();

    const abortError = new AnthropicUserAbortError();
    const streamStub = buildStreamStub(abortError);

    const client = streamClientOf(streamStub);

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
    const handler = createStreamingHandler();

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

    const client = streamClientOf(streamStub);

    const messages = helloMessages();

    await assert.rejects(
      handler.createResponse({ client, messages, temperature: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'expected an Error to be thrown');
        // Once message_start was actually received, the pre-message_start
        // wrap guard must not fire and clobber the more specific
        // message_stop-guard error with "closed before message_start".
        assert.ok(
          !/Stream closed before message_start/.test((err as Error).message),
          `expected the original message_stop-guard error to survive unwrapped, got: ${(err as Error).message}`,
        );
        assert.equal((err as Error).message, droppedStreamError.message);
        return true;
      },
    );
  });

  it('keeps raw stream failures out of visible warning logs', async () => {
    const logger = {
      ...noopTrace,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      domain: vi.fn(),
    };
    const handler = createStreamingHandler(logger as unknown as AgentTrace);

    const providerError = new AnthropicBadRequestError(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'Your credit balance is too low to access the Anthropic API.',
        },
        request_id: 'req_low_credit',
      },
      undefined,
      new Headers([['request-id', 'req_low_credit']]),
    );
    const stream = buildStreamStub(providerError);
    const client = streamClientOf(stream);

    await expect(
      handler.createResponse({
        client,
        messages: helloMessages(),
        temperature: 0,
      }),
    ).rejects.toBe(providerError);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'Stream failed',
      expect.objectContaining({
        data: expect.objectContaining({
          partialTextLength: 0,
        }),
      }),
    );
  });
});
