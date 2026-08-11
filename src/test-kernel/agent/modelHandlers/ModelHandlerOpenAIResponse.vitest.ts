// Node imports
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { describe, it, vi } from 'vitest';
import {
  MODEL_CONFIGS,
  type ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from 'llm-zoo';
import { APIUserAbortError, OpenAIError } from 'openai';

// Local imports
import { noopTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentSettingSchema } from '@agent/core/definition/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { tagOpenAISdkError } from '@agent/modelHandlers/openai/openAISdkError';
import type {
  ModelCredentialRoute,
  OpenAIResponseToolCall,
} from '@agent/types/ModelHandlerContracts';
import { BackgroundPoller } from '@agent/modelHandlers/support/BackgroundPoller';
import {
  attachContextWindowError,
  hasContextWindowErrorMarker,
} from '@common/errors/sdkError/errorMetadata';
import {
  isContextWindowError,
  isUserAbort,
} from '@common/errors/sdkError/errorPatterns';
import {
  isProviderErrorAutoRetryable,
  normalizeProviderError,
} from '@common/errors/sdkError/providerErrorFormat';
import type { ToolDefinition } from '@model/ToolDefinition';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { AgentCategory } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { spiedTrace } from '@test/support/spiedTrace';
import { pathToLocation } from '@utils/files/fileLocation';
import type {
  ResponseInputItem,
  ResponseUsage,
} from 'openai/resources/responses/responses';
import type OpenAI from 'openai';

// pathToLocation and AbsoluteFS resolve through platform services, so this
// suite needs the real node fs rather than the in-memory default.
setupPlatform({}, { fs: nodeFilesystem });

const OPENAI_RESPONSE_TEST_CONFIG = Object.freeze({
  name: 'gpt-4.1',
  fullName: 'gpt-4.1',
  shortName: 'gpt-4.1',
  label: 'GPT 4.1',
  provider: ModelProvider.OPENAI,
  capabilities: Object.freeze({
    supportsReasoning: false,
    supportsVision: false,
  }),
  openRouterOnly: true,
});

type TestModelConfigOverrides = Parameters<typeof buildTestModelConfig>[1];

/** A logged handler of the given subclass, pinned to the non-streaming path. */
function createHandlerOf<T extends ModelHandlerOpenAIResponse>(
  Handler: new (config: ModelConfig) => T,
  configOverrides: TestModelConfigOverrides = {},
): T {
  const handler = new Handler(
    buildTestModelConfig(OPENAI_RESPONSE_TEST_CONFIG, configOverrides),
  );
  handler.setLogger({ ...noopTrace });
  handler.getStreamingConfig = () => false;
  return handler;
}

function createHandler(
  configOverrides: TestModelConfigOverrides = {},
): ModelHandlerOpenAIResponse {
  return createHandlerOf(ModelHandlerOpenAIResponse, configOverrides);
}

function createStreamingHandler(
  configOverrides: TestModelConfigOverrides = {},
): ModelHandlerOpenAIResponse {
  const handler = createHandler(configOverrides);
  handler.getStreamingConfig = () => true;
  return handler;
}

class NonChainingResponseHandler extends ModelHandlerOpenAIResponse {
  protected override get supportsResponseChaining(): boolean {
    return false;
  }

  protected override get supportsInlineInputFileUpload(): boolean {
    return false;
  }
}

class StatelessResponseHandler extends ModelHandlerOpenAIResponse {
  protected override get storesResponsesServerSide(): boolean {
    return false;
  }
}

class ResponseRouteProbe extends ModelHandlerOpenAIResponse {
  tagClient(client: OpenAI, route: ModelCredentialRoute): OpenAI {
    return this.rememberClientCredentialRoute(client, route, 'test-credential');
  }

  usesOpenRouter(): boolean {
    return this.isOpenRouterRoutingEnabled();
  }
}

function createNonChainingHandler(
  configOverrides: TestModelConfigOverrides = {},
): ModelHandlerOpenAIResponse {
  return createHandlerOf(NonChainingResponseHandler, configOverrides);
}

function createResponse(id: string, usage?: { input_tokens: number }) {
  return {
    id,
    status: 'completed',
    output: [],
    output_text: 'ok',
    usage,
  };
}

/** A client that records every `responses.create` request it is sent. */
function createCapturingClient(responseId: string) {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    client: {
      responses: {
        create: async (params: Record<string, unknown>) => {
          requests.push(params);
          return createResponse(responseId, { input_tokens: 12 });
        },
      },
    } as unknown as OpenAI,
  };
}

/**
 * A client that records every `responses.create` request and answers the n-th
 * (1-based) call with `respond(n)`.
 */
function createSequentialClient(respond: (call: number) => unknown) {
  const requests: any[] = [];
  const client = {
    responses: {
      create: async (params: any) => {
        requests.push(params);
        return respond(requests.length);
      },
    },
  };
  return { client, requests };
}

type StreamScript = {
  /** Events the stream yields, in order. */
  events?: unknown[];
  /** Error the stream throws after yielding every event. */
  error?: unknown;
  /** Defaults to a guard that throws when finalResponse is called. */
  finalResponse?: () => Promise<unknown>;
  /** Defaults to a guard that throws when retrieve is called. */
  retrieve?: (...args: any[]) => unknown;
};

/** A client whose stream replays `events` and then throws `error` if set. */
function createStreamClient(script: StreamScript) {
  return {
    responses: {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          for (const event of script.events ?? []) yield event;
          if (script.error) throw script.error;
        },
        finalResponse:
          script.finalResponse ??
          (async () => {
            throw new Error('unexpected finalResponse call');
          }),
      }),
      retrieve:
        script.retrieve ??
        (async () => {
          throw new Error('unexpected retrieve call');
        }),
    },
  };
}

/**
 * A stream that announces its response id and then dies on an unhandled SDK
 * event, the shape that drives the retrieve-by-id fallback.
 */
function createUnhandledEventStream(responseId: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'response.created', response: { id: responseId } };
      throw new OpenAIError(
        'Unhandled response stream event: response.keepalive',
      );
    },
    finalResponse: async () => {
      throw new Error('fallback stream should retrieve by id');
    },
  };
}

/** Replaces the background poller with one that polls without waiting. */
function installImmediatePoller(handler: ModelHandlerOpenAIResponse): void {
  backgroundLifecycleInternals(handler).backgroundPoller =
    new BackgroundPoller<{
      id?: string;
      status?: string | null;
    }>({
      pollIntervalMs: 0,
      maxDurationMs: 1000,
      isPending: (response) =>
        response.status === 'queued' || response.status === 'in_progress',
      logger: { ...noopTrace },
    });
}

/**
 * Replaces compaction with one that keeps only the last message and records
 * the transcript it was handed.
 */
function stubCompactionToLastMessage(
  handler: ModelHandlerOpenAIResponse,
  compactionResultExtras: { tokensAfter?: number } = {},
): ResponseInputItem[][] {
  const compactCalls: ResponseInputItem[][] = [];
  const target = handler as unknown as {
    compactConversation: unknown;
    compactionResult: unknown;
  };
  target.compactConversation = async (
    _client: unknown,
    msgs: ResponseInputItem[],
  ) => {
    compactCalls.push(msgs);
    const compacted = msgs.slice(-1);
    target.compactionResult = {
      sourceMessages: msgs,
      compactedMessages: compacted,
      ...compactionResultExtras,
    };
    return compacted;
  };
  return compactCalls;
}

function withSdkOptions<T extends { responses: object }>(client: T) {
  return Object.assign(client, {
    withOptions: vi.fn(() => client),
  });
}

/**
 * A client whose pre-flight token count answers `inputTokensPerCall` (keyed by
 * the 1-based call index) and whose `responses.create` records every request,
 * answering each with a sequentially numbered completed response.
 */
function createPreflightCountingClient(
  inputTokensPerCall: (call: number) => number,
) {
  const requests: any[] = [];
  const tokenCounts: number[] = [];
  const client = withSdkOptions({
    responses: {
      inputTokens: {
        count: async () => {
          const inputTokens = inputTokensPerCall(tokenCounts.length + 1);
          tokenCounts.push(inputTokens);
          return { input_tokens: inputTokens };
        },
      },
      create: async (params: any) => {
        requests.push(params);
        return createResponse(`resp-${requests.length}`, {
          input_tokens: 100000,
        });
      },
    },
  });
  return { client, requests, tokenCounts };
}

function createBackgroundAbortHandler(): ModelHandlerOpenAIResponse {
  const handler = new ModelHandlerOpenAIResponse(
    buildTestModelConfig({
      name: 'test-gpt',
      label: 'Test GPT',
      fullName: 'gpt-test',
      shortName: 'gpt-test',
      provider: ModelProvider.OPENAI,
      maxOutputTokens: 1024,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 200000,
      openRouterOnly: false,
    }),
  );
  handler.setLogger(spiedTrace());
  return handler;
}

type BackgroundLifecycleInternals = {
  backgroundPoller: BackgroundPoller<{
    id?: string;
    status?: string | null;
  }>;
  pendingResponseId: string | null;
  retrieveAndRemember(
    client: OpenAI,
    responseId: string,
    retrieveParams: undefined,
    signal: undefined,
  ): Promise<unknown>;
  tryResume(client: OpenAI, signal?: AbortSignal): Promise<unknown>;
};

function backgroundLifecycleInternals(
  handler: ModelHandlerOpenAIResponse,
): BackgroundLifecycleInternals {
  return (
    handler as unknown as { backgroundLifecycle: BackgroundLifecycleInternals }
  ).backgroundLifecycle;
}

function createRetrieveThrowingClient(error: unknown): OpenAI {
  return {
    responses: {
      retrieve: vi.fn(async () => {
        throw error;
      }),
    },
  } as unknown as OpenAI;
}

describe('ModelHandlerOpenAIResponse auxiliary requests', () => {
  it('restores SDK retries for tool-result uploads outside the model gate', async () => {
    const handler = createHandler({ openRouterOnly: false });
    const create = vi.fn(async () => ({ id: 'file-1' }));
    const uploadClient = { files: { create } };
    const withOptions = vi.fn(() => uploadClient);
    const client = { withOptions } as unknown as OpenAI;
    const call: OpenAIResponseToolCall = {
      provider: 'openai-response',
      callId: 'call-1',
      name: 'read_file',
      input: {},
      raw: {
        type: 'function_call',
        call_id: 'call-1',
        name: 'read_file',
        arguments: '{}',
      } as OpenAIResponseToolCall['raw'],
    };

    await handler.createToolUseFollowUpMessages(
      client,
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
    assert.equal(create.mock.calls.length, 1);
  });
});

function createMessages(count: number): ResponseInputItem[] {
  return Array.from({ length: count }, (_, index) => ({
    role: 'user',
    content: `message ${index + 1}`,
  })) as ResponseInputItem[];
}

describe('ModelHandlerOpenAIResponse.createMediaContent', () => {
  it('sends inline PDFs as data URLs', () => {
    const handler = createNonChainingHandler({ openRouterOnly: false });

    assert.deepEqual(
      handler.createMediaContent([
        {
          file_name: 'paper.pdf',
          data: 'JVBERi0xLjc=',
          media_type: 'application/pdf',
          media_category: 'image',
        },
      ]),
      [
        { type: 'input_text', text: 'Document: paper.pdf' },
        {
          type: 'input_file',
          file_data: 'data:application/pdf;base64,JVBERi0xLjc=',
          filename: 'paper.pdf',
        },
      ],
    );
  });
});

describe('ModelHandlerOpenAIResponse.createResponse', () => {
  it('uses the client route instead of mutable OpenRouter configuration during an attempt', async () => {
    const handler = createHandlerOf(ResponseRouteProbe, {
      openRouterOnly: true,
    });
    const client = handler.tagClient(
      {
        responses: {
          create: async () => {
            assert.equal(handler.usesOpenRouter(), false);
            return createResponse('resp-direct-route', { input_tokens: 1 });
          },
        },
      } as unknown as OpenAI,
      'api-key',
    );

    await handler.createResponse({
      client,
      messages: createMessages(1),
      temperature: 0,
    });
  });

  it.each([
    {
      // GPT-5.6 Pro shares gpt-5.6-sol's wire id; pro execution is selected by
      // the request's reasoning.mode, driven by the reasoningMode capability.
      name: 'sends reasoning.mode for pro-mode registry entries (GPT-5.6 Pro)',
      overrides: {
        name: 'gpt56pro',
        fullName: 'gpt-5.6-sol',
        shortName: 'gpt-5.6-pro',
        capabilities: {
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.MEDIUM,
          reasoningMode: 'pro' as const,
        },
      },
      expected: { mode: 'pro', effort: 'medium' },
    },
    {
      name: 'sends max effort when the model declares max as its native ceiling',
      overrides: {
        name: 'gpt56',
        fullName: 'gpt-5.6-sol',
        capabilities: {
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.MAX,
          maxReasoningEffort: ReasoningEffort.MAX,
        },
      },
      expected: { mode: undefined, effort: 'max' },
    },
  ])('$name', async ({ overrides, expected }) => {
    const handler = createHandler(overrides);
    const { client, requests } = createCapturingClient(
      `resp-${overrides.name}`,
    );

    await handler.createResponse({
      client,
      messages: createMessages(1),
      temperature: 0,
    });

    const reasoning = requests[0]?.reasoning as
      { effort?: string; mode?: string } | undefined;
    assert.equal(reasoning?.mode, expected.mode);
    assert.equal(reasoning?.effort, expected.effort);
  });

  it('does not mistake a user override for the model native ceiling', async () => {
    const handler = createHandler({
      name: 'reasoning-model',
      fullName: 'reasoning-model',
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffort: ReasoningEffort.MEDIUM,
      },
    });
    handler.capabilities.reasoningEffort = ReasoningEffort.MAX;
    const { client, requests } = createCapturingClient('resp-clamped-override');

    await handler.createResponse({
      client,
      messages: createMessages(1),
      temperature: 0,
    });

    const reasoning = requests[0]?.reasoning as { effort?: string } | undefined;
    assert.equal(reasoning?.effort, 'xhigh');
  });

  it('enables parallel tool calls by default', async () => {
    const handler = createHandler();
    const { client, requests } = createCapturingClient('resp-parallel-tools');
    const tools: ToolDefinition[] = [
      { name: 'lookup', description: 'Look up a value' },
    ];

    await handler.createResponse({
      client,
      messages: createMessages(1),
      temperature: 0,
      tools,
    });

    assert.equal(requests[0]?.tool_choice, 'auto');
    assert.equal(requests[0]?.parallel_tool_calls, true);
  });

  it('maps finalTool to a named Responses function choice', async () => {
    const handler = createHandler();
    const { client, requests } = createCapturingClient('resp-forced-tool');
    const tools: ToolDefinition[] = [
      { name: 'submit_output', description: 'Submit output' },
    ];

    await handler.createResponse({
      client,
      messages: createMessages(1),
      temperature: 0,
      tools,
      finalTool: { name: 'submit_output' },
    });

    assert.deepEqual(requests[0]?.tool_choice, {
      type: 'function',
      name: 'submit_output',
    });
    assert.equal(handler.supportsForcedToolChoice, true);
  });

  it('rejects concurrent calls on the same handler instance', async () => {
    const handler = createHandler();
    let resolveCreate: (response: unknown) => void = () => undefined;
    const firstResponse = new Promise<unknown>((resolve) => {
      resolveCreate = resolve;
    });
    const client = {
      responses: {
        create: () => firstResponse,
      },
    } as unknown as OpenAI;

    const firstCall = handler.createResponse({
      client,
      messages: createMessages(1),
      temperature: 0,
    });

    await assert.rejects(
      handler.createResponse({
        client,
        messages: createMessages(1),
        temperature: 0,
      }),
      /single-turn per instance/,
    );

    resolveCreate(createResponse('resp-1', { input_tokens: 12 }));
    await firstCall;
  });

  it.each([
    {
      name: 'a completed response without usage disables chaining',
      buildHandler: () => createHandler(),
      respond: (call: number) =>
        call === 1
          ? createResponse('resp-missing-usage')
          : createResponse('resp-2', { input_tokens: 20 }),
    },
    {
      name: 'response chaining is unsupported',
      buildHandler: () => createNonChainingHandler(),
      respond: (call: number) =>
        createResponse(`resp-${call}`, { input_tokens: 20 }),
    },
  ])('sends full history when $name', async ({ buildHandler, respond }) => {
    const handler = buildHandler();
    const { client, requests } = createSequentialClient(respond);
    const firstTurnMessages = createMessages(2);
    const secondTurnMessages = createMessages(3);

    await handler.createResponse({
      client: client as any,
      messages: firstTurnMessages,
      temperature: 0,
    });
    await handler.createResponse({
      client: client as any,
      messages: secondTurnMessages,
      temperature: 0,
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[1].previous_response_id, undefined);
    assert.deepEqual(requests[1].input, secondTurnMessages);
  });

  it('leaves inline input files in place when upload is unsupported', async () => {
    const handler = createNonChainingHandler({ openRouterOnly: false });
    const requests: any[] = [];
    const client = {
      files: {
        create: () => {
          throw new Error('files.create should not be called');
        },
      },
      responses: {
        inputTokens: {
          count: async () => ({ input_tokens: 12 }),
        },
        create: async (params: any) => {
          requests.push(params);
          return createResponse('resp-inline-file', { input_tokens: 12 });
        },
      },
    };
    const fileMessage = {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_file',
          filename: 'paper.pdf',
          file_data: 'data:application/pdf;base64,AA==',
        },
      ],
    } as unknown as ResponseInputItem;

    await handler.createResponse({
      client: client as any,
      messages: [fileMessage],
      temperature: 0,
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].input, [fileMessage]);
  });

  it('merges streamed output items when final streaming output is partial', async () => {
    const handler = createStreamingHandler();

    const reasoningItem = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
    };
    const functionCallItem = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{}',
      status: 'completed',
    };
    const finalResponse = {
      id: 'resp-partial-stream',
      status: 'completed',
      output: [reasoningItem],
      output_text: '',
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        total_tokens: 3,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    const events = [
      { type: 'response.output_item.done', item: reasoningItem },
      { type: 'response.output_item.done', item: functionCallItem },
    ];
    const client = {
      responses: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
          finalResponse: async () => finalResponse,
        }),
      },
    };

    const result = await handler.createResponse({
      client: client as any,
      messages: createMessages(1),
      temperature: 0,
    });

    assert.deepEqual(result.response.output, [reasoningItem, functionCallItem]);
  });

  it('keeps healthy streams on finalResponse after response.created', async () => {
    const handler = createStreamingHandler();

    let finalResponseCalls = 0;
    let retrieveCalls = 0;
    const finalResponse = createResponse('resp-stream-ok', {
      input_tokens: 12,
    });
    const client = createStreamClient({
      events: [
        { type: 'response.created', response: { id: 'resp-stream-ok' } },
        { type: 'response.output_text.delta', delta: 'ok' },
      ],
      finalResponse: async () => {
        finalResponseCalls += 1;
        return finalResponse;
      },
      retrieve: async () => {
        retrieveCalls += 1;
        throw new Error('healthy stream should not retrieve by id');
      },
    });

    const result = await handler.createResponse({
      client: client as any,
      messages: createMessages(1),
      temperature: 0,
    });

    assert.equal(result.response.id, 'resp-stream-ok');
    assert.equal(finalResponseCalls, 1);
    assert.equal(retrieveCalls, 0);
  });

  it('falls back to retrieve when finalResponse sees an unhandled stream event', async () => {
    const handler = createStreamingHandler();

    const retrieveCalls: string[] = [];
    const recoveredResponse = createResponse('resp-final-fallback', {
      input_tokens: 12,
    });
    const client = createStreamClient({
      events: [
        { type: 'response.created', response: { id: 'resp-final-fallback' } },
      ],
      finalResponse: async () => {
        throw new OpenAIError(
          'Unhandled response stream event: response.keepalive',
        );
      },
      retrieve: async (id: string) => {
        retrieveCalls.push(id);
        return recoveredResponse;
      },
    });

    const result = await handler.createResponse({
      client: client as any,
      messages: createMessages(1),
      temperature: 0,
    });

    assert.equal(result.response.id, 'resp-final-fallback');
    assert.deepEqual(retrieveCalls, ['resp-final-fallback']);
  });

  it('rethrows unhandled stream events before response.created', async () => {
    const handler = createStreamingHandler();

    let retrieveCalls = 0;
    const client = createStreamClient({
      error: new OpenAIError(
        'Unhandled response stream event: response.keepalive',
      ),
      retrieve: async () => {
        retrieveCalls += 1;
        throw new Error('stream without response id should not retrieve');
      },
    });

    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: createMessages(1),
        temperature: 0,
      }),
      /Unhandled response stream event/,
    );
    assert.equal(retrieveCalls, 0);
  });

  it('rethrows non-OpenAI stream errors without polling', async () => {
    const handler = createStreamingHandler();

    let retrieveCalls = 0;
    const client = createStreamClient({
      events: [
        { type: 'response.created', response: { id: 'resp-network-error' } },
      ],
      error: new TypeError('network unavailable'),
      retrieve: async () => {
        retrieveCalls += 1;
        throw new Error('non-OpenAI stream error should not retrieve');
      },
    });

    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: createMessages(1),
        temperature: 0,
      }),
      /network unavailable/,
    );
    assert.equal(retrieveCalls, 0);
  });

  it('does not retrieve stateless responses after an unhandled stream event', async () => {
    const handler = createHandlerOf(StatelessResponseHandler);
    handler.getStreamingConfig = () => true;

    let retrieveCalls = 0;
    const client = createStreamClient({
      events: [
        {
          type: 'response.created',
          response: { id: 'resp-stateless-fallback' },
        },
      ],
      error: new OpenAIError(
        'Unhandled response stream event: response.keepalive',
      ),
      retrieve: async () => {
        retrieveCalls += 1;
        throw new Error('stateless stream should not retrieve by id');
      },
    });

    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: createMessages(1),
        temperature: 0,
      }),
      /Unhandled response stream event/,
    );
    assert.equal(retrieveCalls, 0);
  });

  it('preserves include fields when polling after an unhandled stream event', async () => {
    const handler = createStreamingHandler({
      capabilities: {
        supportsNativeWebSearch: true,
      },
    });
    installImmediatePoller(handler);

    const retrieveCalls: Array<{
      id: string;
      params: unknown;
      options: unknown;
    }> = [];
    const pendingResponse = {
      ...createResponse('resp-stream-fallback', { input_tokens: 12 }),
      status: 'in_progress',
    };
    const recoveredResponse = createResponse('resp-stream-fallback', {
      input_tokens: 12,
    });
    const retrievedResponses = [pendingResponse, recoveredResponse];
    const client = {
      responses: {
        stream: () => createUnhandledEventStream('resp-stream-fallback'),
        retrieve: async (id: string, params: unknown, options: unknown) => {
          retrieveCalls.push({ id, params, options });
          const response = retrievedResponses.shift();
          if (!response) throw new Error('unexpected extra retrieve');
          return response;
        },
      },
    };

    const result = await handler.createResponse({
      client: client as any,
      messages: createMessages(1),
      temperature: 0,
    });

    assert.equal(result.response.id, 'resp-stream-fallback');
    assert.deepEqual(retrieveCalls, [
      {
        id: 'resp-stream-fallback',
        params: { include: ['web_search_call.action.sources'] },
        options: undefined,
      },
      {
        id: 'resp-stream-fallback',
        params: { include: ['web_search_call.action.sources'] },
        options: undefined,
      },
    ]);
  });

  it('resumes a fallback response when the first retrieve fails', async () => {
    const handler = createStreamingHandler({
      openRouterOnly: false,
      capabilities: {
        supportsNativeWebSearch: true,
      },
    });

    let streamCalls = 0;
    let tokenCountCalls = 0;
    const retrieveCalls: Array<{ id: string; params: unknown }> = [];
    const client = withSdkOptions({
      responses: {
        inputTokens: {
          count: async () => {
            tokenCountCalls += 1;
            return { input_tokens: 100 };
          },
        },
        stream: () => {
          streamCalls += 1;
          return createUnhandledEventStream('resp-retrieve-retry');
        },
        retrieve: async (id: string, params: unknown) => {
          retrieveCalls.push({ id, params });
          if (retrieveCalls.length === 1) {
            throw new TypeError('retrieve unavailable');
          }
          return createResponse('resp-retrieve-retry', {
            input_tokens: 12,
          });
        },
      },
    });

    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: createMessages(1),
        temperature: 0,
      }),
      /retrieve unavailable/,
    );

    const result = await handler.createResponse({
      client: client as any,
      messages: createMessages(1),
      temperature: 0,
    });

    assert.equal(result.response.id, 'resp-retrieve-retry');
    assert.equal(streamCalls, 1);
    assert.equal(tokenCountCalls, 1);
    assert.deepEqual(client.withOptions.mock.calls, [[{ maxRetries: 2 }]]);
    assert.deepEqual(retrieveCalls, [
      {
        id: 'resp-retrieve-retry',
        params: { include: ['web_search_call.action.sources'] },
      },
      {
        id: 'resp-retrieve-retry',
        params: { include: ['web_search_call.action.sources'] },
      },
    ]);
  });

  it('resumes fallback polling with include fields after a poll failure', async () => {
    const handler = createStreamingHandler({
      capabilities: {
        supportsNativeWebSearch: true,
      },
    });
    installImmediatePoller(handler);

    let streamCalls = 0;
    const retrieveCalls: Array<{ id: string; params: unknown }> = [];
    const pendingResponse = {
      ...createResponse('resp-poll-retry', { input_tokens: 12 }),
      status: 'in_progress',
    };
    const completedResponse = createResponse('resp-poll-retry', {
      input_tokens: 12,
    });
    const client = {
      responses: {
        stream: () => {
          streamCalls += 1;
          return createUnhandledEventStream('resp-poll-retry');
        },
        retrieve: async (id: string, params: unknown) => {
          retrieveCalls.push({ id, params });
          if (retrieveCalls.length === 1) return pendingResponse;
          if (retrieveCalls.length === 2) {
            throw new TypeError('poll unavailable');
          }
          return completedResponse;
        },
      },
    };

    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: createMessages(1),
        temperature: 0,
      }),
      /poll unavailable/,
    );

    const result = await handler.createResponse({
      client: client as any,
      messages: createMessages(1),
      temperature: 0,
    });

    assert.equal(result.response.id, 'resp-poll-retry');
    assert.equal(streamCalls, 1);
    assert.deepEqual(retrieveCalls, [
      {
        id: 'resp-poll-retry',
        params: { include: ['web_search_call.action.sources'] },
      },
      {
        id: 'resp-poll-retry',
        params: { include: ['web_search_call.action.sources'] },
      },
      {
        id: 'resp-poll-retry',
        params: { include: ['web_search_call.action.sources'] },
      },
    ]);
  });

  it('uses the preserved token baseline after an invalid previous response id clears chaining', async () => {
    const handler = createHandler({
      openRouterOnly: false,
      maxOutputTokens: 120000,
      contextWindow: 200000,
    });
    const requests: any[] = [];
    let tokenCountCalls = 0;
    const client = withSdkOptions({
      responses: {
        inputTokens: {
          count: async () => {
            tokenCountCalls += 1;
            if (tokenCountCalls === 3) {
              throw new Error('token counting unavailable');
            }
            return { input_tokens: 1000 };
          },
        },
        create: async (params: any) => {
          requests.push(params);
          if (requests.length === 1) {
            return createResponse('resp-baseline', { input_tokens: 100000 });
          }
          if (requests.length === 2) {
            throw new Error(
              "Previous response with id 'resp-baseline' not found.",
            );
          }
          return createResponse('resp-rebuilt', { input_tokens: 100500 });
        },
      },
    });
    const firstTurnMessages = createMessages(2);
    const rebuiltMessages = createMessages(3);

    await handler.createResponse({
      client: client as any,
      messages: firstTurnMessages,
      temperature: 0,
    });

    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: rebuiltMessages,
        temperature: 0,
      }),
      /Previous response/,
    );
    await handler.createResponse({
      client: client as any,
      messages: rebuiltMessages,
      temperature: 0,
    });

    assert.equal(requests.length, 3);
    assert.equal(requests[1].previous_response_id, 'resp-baseline');
    assert.equal(requests[2].previous_response_id, undefined);
    assert.deepEqual(requests[2].input, rebuiltMessages);
    assert.equal(tokenCountCalls, 3);
    assert.equal(requests[2].max_output_tokens, 99990);
  });

  it('compacts before sending when the live pre-flight count crosses the threshold', async () => {
    const handler = createHandler({
      openRouterOnly: false,
      contextWindow: 200000,
    });
    const compactCalls = stubCompactionToLastMessage(handler, {
      tokensAfter: 1000,
    });
    // Turn 2's live pre-flight count lands between the 75% threshold (150k)
    // and the 200k window, so compaction runs before the request goes out.
    const { client, requests, tokenCounts } = createPreflightCountingClient(
      (call) => (call === 2 ? 180000 : 1000),
    );

    await handler.createResponse({
      client: client as any,
      messages: createMessages(2),
      temperature: 0,
    });

    const secondTurn = createMessages(4);
    const result = await handler.createResponse({
      client: client as any,
      messages: secondTurn,
      temperature: 0,
    });

    assert.equal(result.response.id, 'resp-2');
    assert.equal(requests.length, 2);
    assert.equal(compactCalls.length, 1);
    assert.equal(tokenCounts.length, 3);
    assert.deepEqual(requests[1].input, secondTurn.slice(-1));
  });

  it.each([
    {
      name: 'chained route drops the chain',
      buildHandler: () =>
        createHandler({ openRouterOnly: false, contextWindow: 200000 }),
      compactionExtras: {},
    },
    {
      name: 'non-chaining route has no chain to drop',
      buildHandler: () =>
        createNonChainingHandler({
          openRouterOnly: false,
          contextWindow: 200_000,
        }),
      compactionExtras: { tokensAfter: 1000 },
    },
  ])(
    'recovers a pre-flight context-window overflow by compacting ($name)',
    async ({ buildHandler, compactionExtras }) => {
      // Turn 2's pre-flight count overflows the 200k window (it includes
      // server-side chained history); the internal retry after dropping the
      // chain and compacting fits again, so the overflow never escapes to
      // the caller.
      const handler = buildHandler();
      const compactCalls = stubCompactionToLastMessage(
        handler,
        compactionExtras,
      );
      const { client, requests, tokenCounts } = createPreflightCountingClient(
        (call) => (call === 2 ? 300000 : 1000),
      );

      await handler.createResponse({
        client: client as any,
        messages: createMessages(2),
        temperature: 0,
      });

      const secondTurn = createMessages(4);
      const result = await handler.createResponse({
        client: client as any,
        messages: secondTurn,
        temperature: 0,
      });

      assert.equal(result.response.id, 'resp-2');
      assert.equal(requests.length, 2);
      assert.equal(requests[1].previous_response_id, undefined);
      assert.equal(compactCalls.length, 1);
      assert.equal(tokenCounts.length, 3);
      assert.deepEqual(requests[1].input, secondTurn.slice(-1));
    },
  );

  it('bounds failed compaction recovery and preserves unchained history', async () => {
    const handler = createHandler({
      openRouterOnly: false,
      contextWindow: 200000,
    });
    const compactCalls: ResponseInputItem[][] = [];
    const requests: any[] = [];
    let tokenCountCalls = 0;
    const client = withSdkOptions({
      responses: {
        inputTokens: {
          count: async () => {
            tokenCountCalls += 1;
            return {
              input_tokens:
                tokenCountCalls === 2 || tokenCountCalls === 3 ? 180000 : 1000,
            };
          },
        },
        create: async (params: any) => {
          requests.push(params);
          if (requests.length > 1) {
            const error = new Error('maximum context length exceeded');
            attachContextWindowError(error);
            throw error;
          }
          return createResponse(`resp-${requests.length}`, {
            input_tokens: 100000,
          });
        },
      },
    });
    (
      handler as unknown as { compactConversation: unknown }
    ).compactConversation = async (
      _client: unknown,
      msgs: ResponseInputItem[],
    ) => {
      compactCalls.push(msgs);
      return msgs;
    };

    await handler.createResponse({
      client: client as any,
      messages: createMessages(2),
      temperature: 0,
    });

    const secondTurn = createMessages(4);
    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: secondTurn,
        temperature: 0,
      }),
      /maximum context length exceeded/,
    );

    assert.equal(compactCalls.length, 2);
    assert.equal(requests.length, 3);
    assert.equal(requests[1].previous_response_id, 'resp-1');
    assert.equal(requests[2].previous_response_id, undefined);
    assert.deepEqual(requests[2].input, secondTurn);
  });

  it('tags the fallback hard-failure throw with the context-window marker', () => {
    // Mirrors ModelHandler.validateTokenLimits (#8078, followed up in #8100):
    // isContextWindowError() must recognize this throw via its typed marker,
    // not by string-matching wording that this method owns and may reword
    // freely. Without the marker, a future reword of "exceeds context
    // window" would silently break the
    // `isContextWindowError(error) && this.chainState.hasPreviousResponseId()`
    // compaction-recovery check that reads this throw upstream.
    class FailOnReducedBudgetHandler extends ModelHandlerOpenAIResponse {
      protected override shouldFailWhenFallbackOutputBudgetIsReduced(): boolean {
        return true;
      }
    }
    const handler = createHandlerOf(FailOnReducedBudgetHandler, {
      openRouterOnly: false,
      maxOutputTokens: 200,
      contextWindow: 1000,
    });
    (
      handler as unknown as {
        chainState: { setCumulativeInputTokens: (tokens: number) => void };
      }
    ).chainState.setCumulativeInputTokens(900);

    let caught: unknown;
    try {
      (
        handler as unknown as {
          applyTokenCountFailureFallback: (maxOutputTokens: number) => number;
        }
      ).applyTokenCountFailureFallback(200);
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Error);
    assert.match(caught.message, /exceeds context window/);
    // Load-bearing assertion: the typed marker itself, independent of the
    // fenced-string fallback that `isContextWindowError` also happens to
    // match today (this exact message currently contains "exceeds context
    // window"). The marker is what keeps classification correct if that
    // wording is ever reworded on the assumption it's Anthropic-only.
    assert.equal(hasContextWindowErrorMarker(caught), true);
    assert.equal(isContextWindowError(caught), true);
  });
});

describe('ModelHandlerOpenAIResponse.extractResponse', () => {
  const USAGE = {
    input_tokens: 1,
    output_tokens: 2,
    total_tokens: 3,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };

  it.each([
    {
      name: 'fills missing output_text from output message parts',
      response: {
        id: 'resp-output-fallback',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'alpha ' },
              { type: 'output_text', text: 'beta' },
            ],
          },
        ],
      },
      endTag: '',
      expected: 'alpha beta',
    },
    {
      name: 'preserves top-level output_text when output has no message text',
      response: {
        id: 'resp-top-level-text',
        output_text: 'relay text',
        output: [{ type: 'reasoning', id: 'rs_1', summary: [] }],
      },
      endTag: '',
      expected: 'relay text',
    },
    {
      name: 'uses top-level output_text when output is absent',
      response: { id: 'resp-output-missing', output_text: 'relay text' },
      endTag: '',
      expected: 'relay text',
    },
    {
      name: 'fills blank output_text from output message parts',
      response: {
        id: 'resp-blank-output-text',
        output_text: '   ',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'fallback text' }],
          },
        ],
      },
      endTag: '',
      expected: 'fallback text',
    },
    {
      // The Responses API has no `stop` parameter, so a "completed" status
      // never implies the provider stripped the end tag from the output.
      // Forging it here would mask genuinely incomplete output as done.
      name: 'does not forge a missing end tag onto a completed response',
      response: {
        id: 'resp-no-end-tag',
        output_text: 'the document body without a closing tag',
      },
      endTag: '</documents>',
      expected: 'the document body without a closing tag',
    },
  ])('$name', ({ response, endTag, expected }) => {
    const result = createHandler().extractResponse(
      { ...response, status: 'completed', usage: USAGE } as any,
      endTag,
    );

    assert.equal(result.text, expected);
  });
});

describe('ModelHandlerOpenAIResponse.initializeOutputAndPrefill', () => {
  it('preserves user content when no output file exists', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openai-response-prefill-empty-'),
    );
    const outputPath = path.join(tempDir, 'r0', 'output.xml');

    try {
      const handler = createHandler();
      const agentSetting = AgentSettingSchema.parse({
        agentCategory: AgentCategory.Workflow,
      });
      const userMessage: ResponseInputItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'revise the document' }],
      } as ResponseInputItem;
      const messages: ResponseInputItem[] = [userMessage];
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
      assert.equal(updatedMessages.length, 1);
      const onlyContent = (updatedMessages[0] as any).content;
      assert.deepEqual(onlyContent, [
        { type: 'input_text', text: 'revise the document' },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('ModelHandlerOpenAIResponse.normalizeUsage', () => {
  it('maps cache writes and derives usage attribution from configuration', () => {
    const handler = createHandler({ provider: ModelProvider.META });
    const usage: ResponseUsage = {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 10, cache_write_tokens: 15 },
      output_tokens_details: { reasoning_tokens: 0 },
    } as ResponseUsage;

    const normalized = handler.normalizeUsage(usage, 0);

    assert.equal(normalized.provider, 'meta');
    assert.equal(normalized.cacheCreationTokens, 15);
    assert.equal(normalized.cachedInputTokens, 10);
  });

  it('defaults cacheCreationTokens to undefined when cache_write_tokens is absent', () => {
    const handler = createHandler();
    const usage: ResponseUsage = {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    } as ResponseUsage;

    const normalized = handler.normalizeUsage(usage, 0);

    assert.equal(normalized.cacheCreationTokens, undefined);
  });
});

describe('ModelHandlerOpenAIResponse background abort handling', () => {
  // Pins the SDK contract the abort path depends on: openai throws its own
  // APIUserAbortError (not a DOMException) when the signal fires inside
  // retrieve(). If an SDK upgrade changes this, the abort path must be
  // re-verified.
  it('recognizes the SDK abort class via isUserAbort once tagged', () => {
    const err = new APIUserAbortError();
    assert.equal(err instanceof DOMException, false);
    tagOpenAISdkError(err, 'openai');
    assert.equal(isUserAbort(err), true);
  });

  it('recognizes plain AbortController DOMExceptions (delay path)', () => {
    const err = new DOMException('This operation was aborted', 'AbortError');
    assert.equal(isUserAbort(err), true);
  });

  it('clears the pending background ID on abort during resume retrieve', async () => {
    const handler = createBackgroundAbortHandler();
    const target = backgroundLifecycleInternals(handler);
    target.pendingResponseId = 'resp_pending_abort';

    const abortError = new APIUserAbortError();
    const client = createRetrieveThrowingClient(abortError);

    await assert.rejects(target.tryResume(client), APIUserAbortError);

    // An aborted resume must not retain the pending ID, or the next run
    // silently resumes a response the user cancelled.
    assert.equal(target.pendingResponseId, null);
  });

  it('retains the pending background ID on transient retrieve failures', async () => {
    const handler = createBackgroundAbortHandler();
    const target = backgroundLifecycleInternals(handler);
    target.pendingResponseId = 'resp_pending_transient';

    const transient = new Error('socket hang up');
    const client = createRetrieveThrowingClient(transient);

    await assert.rejects(target.tryResume(client), /socket hang up/);

    // No status code means the response is likely still alive server-side,
    // so retain its ID for the outer retry.
    assert.equal(target.pendingResponseId, 'resp_pending_transient');
  });

  it('starts a replacement only after an explicit retry of an expired response', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-01T00:00:00.000Z') });
    try {
      const handler = createHandler();
      const lifecycle = backgroundLifecycleInternals(handler);
      const retrieve = vi.fn(async () => {
        throw new Error('socket hang up');
      });
      const create = vi.fn(async () =>
        createResponse('resp-replacement', { input_tokens: 12 }),
      );
      const client = { responses: { retrieve, create } } as unknown as OpenAI;

      await assert.rejects(
        lifecycle.retrieveAndRemember(
          client,
          'resp-expired',
          undefined,
          undefined,
        ),
        /socket hang up/,
      );
      vi.advanceTimersByTime(3 * 60 * 60 * 1000);

      const timeout = await handler
        .createResponse({
          client,
          messages: createMessages(1),
          temperature: 0,
        })
        .catch((error: unknown) => error);

      assert.ok(timeout instanceof Error);
      assert.equal(normalizeProviderError(timeout).userRetryable, true);
      assert.equal(isProviderErrorAutoRetryable(timeout), false);
      assert.equal(create.mock.calls.length, 0);
      assert.equal(retrieve.mock.calls.length, 1);
      assert.equal(lifecycle.pendingResponseId, null);

      const result = await handler.createResponse({
        client,
        messages: createMessages(1),
        temperature: 0,
      });

      assert.equal(result.response.id, 'resp-replacement');
      assert.equal(create.mock.calls.length, 1);
      assert.equal(retrieve.mock.calls.length, 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
