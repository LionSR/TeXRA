// Standard library imports
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'vitest';

// Third-party imports
import { ModelProvider, ReasoningEffort } from 'llm-zoo';
import { OpenAIError } from 'openai';

// Local imports - test support

// Local imports - agent
import { noopTrace, type AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { BackgroundPoller } from '@agent/modelHandlers/support/BackgroundPoller';
import {
  attachContextWindowError,
  hasContextWindowErrorMarker,
  isContextWindowError,
} from '@common/errors/sdkErrorUtils';
import type { ToolDefinition } from '@model';

import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { setupPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

// Local imports - utilities
import { pathToLocation } from '@utils/files';

// Type imports
import type {
  ResponseInputItem,
  ResponseUsage,
} from 'openai/resources/responses/responses';

// pathToLocation and FlexibleFS resolve through platform services, so this
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

function setupHandler<T extends ModelHandlerOpenAIResponse>(handler: T): T {
  handler.setLogger({ ...noopTrace });
  handler.getStreamingConfig = () => false;
  return handler;
}

function createHandler(
  configOverrides: TestModelConfigOverrides = {},
): ModelHandlerOpenAIResponse {
  return setupHandler(
    new ModelHandlerOpenAIResponse(
      buildTestModelConfig(OPENAI_RESPONSE_TEST_CONFIG, configOverrides),
    ),
  );
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

function createNonChainingHandler(
  configOverrides: TestModelConfigOverrides = {},
): ModelHandlerOpenAIResponse {
  return setupHandler(
    new NonChainingResponseHandler(
      buildTestModelConfig(OPENAI_RESPONSE_TEST_CONFIG, configOverrides),
    ),
  );
}

function createStatelessHandler(
  configOverrides: TestModelConfigOverrides = {},
): ModelHandlerOpenAIResponse {
  return setupHandler(
    new StatelessResponseHandler(
      buildTestModelConfig(OPENAI_RESPONSE_TEST_CONFIG, configOverrides),
    ),
  );
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

function createMessages(count: number): ResponseInputItem[] {
  return Array.from({ length: count }, (_, index) => ({
    role: 'user',
    content: `message ${index + 1}`,
  })) as ResponseInputItem[];
}

describe('ModelHandlerOpenAIResponse.createResponse', () => {
  it('sends reasoning.mode for pro-mode registry entries (GPT-5.6 Pro)', async () => {
    // GPT-5.6 Pro shares gpt-5.6-sol's wire id; pro execution is selected by
    // the request's reasoning.mode, driven by the reasoningMode capability.
    const handler = createHandler({
      name: 'gpt56pro',
      fullName: 'gpt-5.6-sol',
      shortName: 'gpt-5.6-pro',
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffort: ReasoningEffort.MEDIUM,
        reasoningMode: 'pro',
      },
    });
    let request: Record<string, unknown> | undefined;
    const client = {
      responses: {
        create: async (params: Record<string, unknown>) => {
          request = params;
          return createResponse('resp-pro-mode', { input_tokens: 12 });
        },
      },
    };

    await handler.createResponse({
      client: client as any,
      messages: createMessages(1),
      temperature: 0,
    });

    const reasoning = request?.reasoning as
      { effort?: string; mode?: string } | undefined;
    assert.equal(reasoning?.mode, 'pro');
    assert.equal(reasoning?.effort, 'medium');
  });

  it('sends max effort when the model declares max as its native ceiling', async () => {
    const handler = createHandler({
      name: 'gpt56',
      fullName: 'gpt-5.6-sol',
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffort: ReasoningEffort.MAX,
        maxReasoningEffort: ReasoningEffort.MAX,
      },
    });
    let request: Record<string, unknown> | undefined;
    const client = {
      responses: {
        create: async (params: Record<string, unknown>) => {
          request = params;
          return createResponse('resp-max-effort', { input_tokens: 12 });
        },
      },
    };

    await handler.createResponse({
      client: client as any,
      messages: createMessages(1),
      temperature: 0,
    });

    const reasoning = request?.reasoning as { effort?: string } | undefined;
    assert.equal(reasoning?.effort, 'max');
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
    let request: Record<string, unknown> | undefined;

    await handler.createResponse({
      client: {
        responses: {
          create: async (params: Record<string, unknown>) => {
            request = params;
            return createResponse('resp-clamped-override', {
              input_tokens: 12,
            });
          },
        },
      } as any,
      messages: createMessages(1),
      temperature: 0,
    });

    const reasoning = request?.reasoning as { effort?: string } | undefined;
    assert.equal(reasoning?.effort, 'xhigh');
  });

  it('enables parallel tool calls by default', async () => {
    const handler = createHandler();
    let request: Record<string, unknown> | undefined;
    const client = {
      responses: {
        create: async (params: Record<string, unknown>) => {
          request = params;
          return createResponse('resp-parallel-tools', { input_tokens: 12 });
        },
      },
    };
    const tools: ToolDefinition[] = [
      { name: 'lookup', description: 'Look up a value' },
    ];

    await handler.createResponse({
      client: client as any,
      messages: createMessages(1),
      temperature: 0,
      tools,
    });

    assert.equal(request?.tool_choice, 'auto');
    assert.equal(request?.parallel_tool_calls, true);
  });

  it('maps finalTool to a named Responses function choice', async () => {
    const handler = createHandler();
    let request: Record<string, unknown> | undefined;
    const tools: ToolDefinition[] = [
      { name: 'submit_output', description: 'Submit output' },
    ];

    await handler.createResponse({
      client: {
        responses: {
          create: async (params: Record<string, unknown>) => {
            request = params;
            return createResponse('resp-forced-tool', { input_tokens: 12 });
          },
        },
      } as any,
      messages: createMessages(1),
      temperature: 0,
      tools,
      finalTool: { name: 'submit_output' },
    });

    assert.deepEqual(request?.tool_choice, {
      type: 'function',
      name: 'submit_output',
    });
    assert.equal(handler.supportsForcedToolChoice, true);
  });

  it('rejects concurrent calls on the same handler instance', async () => {
    const handler = createHandler();
    let resolveCreate: (response: any) => void = () => undefined;
    const firstResponse = new Promise<any>((resolve) => {
      resolveCreate = resolve;
    });
    const client = {
      responses: {
        create: () => firstResponse,
      },
    };

    const firstCall = handler.createResponse({
      client: client as any,
      messages: createMessages(1),
      temperature: 0,
    });

    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: createMessages(1),
        temperature: 0,
      }),
      /single-turn per instance/,
    );

    resolveCreate(createResponse('resp-1', { input_tokens: 12 }));
    await firstCall;
  });

  it('sends full history after a completed response without usage disables chaining', async () => {
    const handler = createHandler();
    const requests: any[] = [];
    const client = {
      responses: {
        create: async (params: any) => {
          requests.push(params);
          return requests.length === 1
            ? createResponse('resp-missing-usage')
            : createResponse('resp-2', { input_tokens: 20 });
        },
      },
    };
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
    assert.equal(requests[0].previous_response_id, undefined);
    assert.equal(requests[1].previous_response_id, undefined);
    assert.deepEqual(requests[1].input, secondTurnMessages);
  });

  it('sends full history when response chaining is unsupported', async () => {
    const handler = createNonChainingHandler();
    const requests: any[] = [];
    const client = {
      responses: {
        create: async (params: any) => {
          requests.push(params);
          return createResponse(`resp-${requests.length}`, {
            input_tokens: 20,
          });
        },
      },
    };
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
    const handler = createHandler();
    handler.getStreamingConfig = () => true;

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
    const handler = createHandler();
    handler.getStreamingConfig = () => true;

    let finalResponseCalls = 0;
    let retrieveCalls = 0;
    const finalResponse = createResponse('resp-stream-ok', {
      input_tokens: 12,
    });
    const client = {
      responses: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'response.created',
              response: { id: 'resp-stream-ok' },
            };
            yield { type: 'response.output_text.delta', delta: 'ok' };
          },
          finalResponse: async () => {
            finalResponseCalls += 1;
            return finalResponse;
          },
        }),
        retrieve: async () => {
          retrieveCalls += 1;
          throw new Error('healthy stream should not retrieve by id');
        },
      },
    };

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
    const handler = createHandler();
    handler.getStreamingConfig = () => true;

    const retrieveCalls: string[] = [];
    const recoveredResponse = createResponse('resp-final-fallback', {
      input_tokens: 12,
    });
    const client = {
      responses: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'response.created',
              response: { id: 'resp-final-fallback' },
            };
          },
          finalResponse: async () => {
            throw new OpenAIError(
              'Unhandled response stream event: response.keepalive',
            );
          },
        }),
        retrieve: async (id: string) => {
          retrieveCalls.push(id);
          return recoveredResponse;
        },
      },
    };

    const result = await handler.createResponse({
      client: client as any,
      messages: createMessages(1),
      temperature: 0,
    });

    assert.equal(result.response.id, 'resp-final-fallback');
    assert.deepEqual(retrieveCalls, ['resp-final-fallback']);
  });

  it('rethrows unhandled stream events before response.created', async () => {
    const handler = createHandler();
    handler.getStreamingConfig = () => true;

    let retrieveCalls = 0;
    const client = {
      responses: {
        stream: () => ({
          [Symbol.asyncIterator]() {
            return {
              async next() {
                throw new OpenAIError(
                  'Unhandled response stream event: response.keepalive',
                );
              },
            };
          },
          finalResponse: async () => {
            throw new Error('stream failure should not call finalResponse');
          },
        }),
        retrieve: async () => {
          retrieveCalls += 1;
          throw new Error('stream without response id should not retrieve');
        },
      },
    };

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
    const handler = createHandler();
    handler.getStreamingConfig = () => true;

    let retrieveCalls = 0;
    const client = {
      responses: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'response.created',
              response: { id: 'resp-network-error' },
            };
            throw new TypeError('network unavailable');
          },
          finalResponse: async () => {
            throw new Error('stream failure should not call finalResponse');
          },
        }),
        retrieve: async () => {
          retrieveCalls += 1;
          throw new Error('non-OpenAI stream error should not retrieve');
        },
      },
    };

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
    const handler = createStatelessHandler();
    handler.getStreamingConfig = () => true;

    let retrieveCalls = 0;
    const client = {
      responses: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'response.created',
              response: { id: 'resp-stateless-fallback' },
            };
            throw new OpenAIError(
              'Unhandled response stream event: response.keepalive',
            );
          },
          finalResponse: async () => {
            throw new Error('stateless stream should not call finalResponse');
          },
        }),
        retrieve: async () => {
          retrieveCalls += 1;
          throw new Error('stateless stream should not retrieve by id');
        },
      },
    };

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
    const handler = createHandler({
      capabilities: {
        supportsNativeWebSearch: true,
      },
    });
    handler.getStreamingConfig = () => true;
    (
      handler as unknown as {
        backgroundLifecycle: { backgroundPoller: BackgroundPoller<any> };
      }
    ).backgroundLifecycle.backgroundPoller = new BackgroundPoller({
      pollIntervalMs: 0,
      maxDurationMs: 1000,
      isPending: (response: { status?: string | null }) =>
        response.status === 'queued' || response.status === 'in_progress',
      logger: { ...noopTrace },
    });

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
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'response.created',
              response: { id: 'resp-stream-fallback' },
            };
            throw new OpenAIError(
              'Unhandled response stream event: response.keepalive',
            );
          },
          finalResponse: async () => {
            throw new Error('fallback stream should retrieve by id');
          },
        }),
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
    const handler = createHandler({
      openRouterOnly: false,
      capabilities: {
        supportsNativeWebSearch: true,
      },
    });
    handler.getStreamingConfig = () => true;

    let streamCalls = 0;
    let tokenCountCalls = 0;
    const retrieveCalls: Array<{ id: string; params: unknown }> = [];
    const client = {
      responses: {
        inputTokens: {
          count: async () => {
            tokenCountCalls += 1;
            return { input_tokens: 100 };
          },
        },
        stream: () => {
          streamCalls += 1;
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'response.created',
                response: { id: 'resp-retrieve-retry' },
              };
              throw new OpenAIError(
                'Unhandled response stream event: response.keepalive',
              );
            },
            finalResponse: async () => {
              throw new Error('fallback stream should retrieve by id');
            },
          };
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
    };

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
    const handler = createHandler({
      capabilities: {
        supportsNativeWebSearch: true,
      },
    });
    handler.getStreamingConfig = () => true;
    (
      handler as unknown as {
        backgroundLifecycle: { backgroundPoller: BackgroundPoller<any> };
      }
    ).backgroundLifecycle.backgroundPoller = new BackgroundPoller({
      pollIntervalMs: 0,
      maxDurationMs: 1000,
      isPending: (response: { status?: string | null }) =>
        response.status === 'queued' || response.status === 'in_progress',
      logger: { ...noopTrace },
    });

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
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'response.created',
                response: { id: 'resp-poll-retry' },
              };
              throw new OpenAIError(
                'Unhandled response stream event: response.keepalive',
              );
            },
            finalResponse: async () => {
              throw new Error('fallback stream should retrieve by id');
            },
          };
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
    const client = {
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
    };
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
    const compactCalls: ResponseInputItem[][] = [];
    const requests: any[] = [];
    let tokenCountCalls = 0;
    const client = {
      responses: {
        inputTokens: {
          count: async () => {
            tokenCountCalls += 1;
            // Turn 2's live count lands between the 75% threshold (150k) and
            // the 200k window: the stale cumulative from turn 1 (100k) would
            // never have triggered, but the live count must.
            return { input_tokens: tokenCountCalls === 2 ? 180000 : 1000 };
          },
        },
        create: async (params: any) => {
          requests.push(params);
          return createResponse(`resp-${requests.length}`, {
            input_tokens: 100000,
          });
        },
      },
    };
    (
      handler as unknown as { compactConversation: unknown }
    ).compactConversation = async (
      _client: unknown,
      msgs: ResponseInputItem[],
    ) => {
      compactCalls.push(msgs);
      const compacted = msgs.slice(-1);
      (handler as unknown as { compactionResult: unknown }).compactionResult = {
        sourceMessages: msgs,
        compactedMessages: compacted,
        tokensAfter: 1000,
      };
      return compacted;
    };

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
    assert.equal(tokenCountCalls, 3);
    assert.deepEqual(requests[1].input, secondTurn.slice(-1));
  });

  it('recovers a pre-flight context-window overflow by dropping the chain and compacting', async () => {
    const handler = createHandler({
      openRouterOnly: false,
      contextWindow: 200000,
    });
    const compactCalls: ResponseInputItem[][] = [];
    const requests: any[] = [];
    let tokenCountCalls = 0;
    const client = {
      responses: {
        inputTokens: {
          count: async () => {
            tokenCountCalls += 1;
            // Turn 2's pre-flight count overflows the 200k window (the count
            // includes server-side chained history); the internal retry after
            // dropping the chain and compacting fits again.
            return { input_tokens: tokenCountCalls === 2 ? 300000 : 1000 };
          },
        },
        create: async (params: any) => {
          requests.push(params);
          return createResponse(`resp-${requests.length}`, {
            input_tokens: 100000,
          });
        },
      },
    };
    (
      handler as unknown as {
        compactConversation: unknown;
        compactionResult: unknown;
      }
    ).compactConversation = async (
      _client: unknown,
      msgs: ResponseInputItem[],
    ) => {
      compactCalls.push(msgs);
      const compacted = msgs.slice(-1);
      (handler as unknown as { compactionResult: unknown }).compactionResult = {
        sourceMessages: msgs,
        compactedMessages: compacted,
      };
      return compacted;
    };

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

    // The overflow never escaped to the caller: the oversized chained request
    // was never sent, and the recovered attempt went out unchained with the
    // compacted transcript.
    assert.equal(result.response.id, 'resp-2');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].previous_response_id, undefined);
    assert.equal(compactCalls.length, 1);
    assert.equal(tokenCountCalls, 3);
    assert.deepEqual(requests[1].input, secondTurn.slice(-1));
  });

  it('recovers an unchained pre-flight overflow by compacting (no previous_response_id to drop)', async () => {
    // cursor[bot]/claude[bot] review finding on this PR: recovery used to
    // require hasPreviousResponseId(), so after invalidateChain() or on a
    // non-chaining route an overflow failed hard without ever attempting
    // compaction — a regression vs the old cumulative-threshold trigger.
    const handler = setupHandler(
      new NonChainingResponseHandler(
        buildTestModelConfig(OPENAI_RESPONSE_TEST_CONFIG, {
          openRouterOnly: false,
          contextWindow: 200_000,
        }),
      ),
    );
    const compactCalls: ResponseInputItem[][] = [];
    const requests: any[] = [];
    let tokenCountCalls = 0;
    const client = {
      responses: {
        inputTokens: {
          count: async () => {
            tokenCountCalls += 1;
            return { input_tokens: tokenCountCalls === 2 ? 300000 : 1000 };
          },
        },
        create: async (params: any) => {
          requests.push(params);
          return createResponse(`resp-${requests.length}`, {
            input_tokens: 100000,
          });
        },
      },
    };
    (
      handler as unknown as { compactConversation: unknown }
    ).compactConversation = async (
      _client: unknown,
      msgs: ResponseInputItem[],
    ) => {
      compactCalls.push(msgs);
      const compacted = msgs.slice(-1);
      (handler as unknown as { compactionResult: unknown }).compactionResult = {
        sourceMessages: msgs,
        compactedMessages: compacted,
        tokensAfter: 1000,
      };
      return compacted;
    };

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
    assert.deepEqual(requests[1].input, secondTurn.slice(-1));
  });

  it('bounds failed compaction recovery and preserves unchained history', async () => {
    const handler = createHandler({
      openRouterOnly: false,
      contextWindow: 200000,
    });
    const compactCalls: ResponseInputItem[][] = [];
    const requests: any[] = [];
    let tokenCountCalls = 0;
    const client = {
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
    };
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
    const handler = setupHandler(
      new FailOnReducedBudgetHandler(
        buildTestModelConfig(OPENAI_RESPONSE_TEST_CONFIG, {
          openRouterOnly: false,
          maxOutputTokens: 200,
          contextWindow: 1000,
        }),
      ),
    );
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
  it('fills missing output_text from output message parts', () => {
    const handler = createHandler();
    const result = handler.extractResponse(
      {
        id: 'resp-output-fallback',
        status: 'completed',
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
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      } as any,
      '',
    );

    assert.equal(result.text, 'alpha beta');
  });

  it('preserves top-level output_text when output has no message text', () => {
    const handler = createHandler();
    const result = handler.extractResponse(
      {
        id: 'resp-top-level-text',
        status: 'completed',
        output_text: 'relay text',
        output: [{ type: 'reasoning', id: 'rs_1', summary: [] }],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      } as any,
      '',
    );

    assert.equal(result.text, 'relay text');
  });

  it('uses top-level output_text when output is absent', () => {
    const handler = createHandler();
    const result = handler.extractResponse(
      {
        id: 'resp-output-missing',
        status: 'completed',
        output_text: 'relay text',
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      } as any,
      '',
    );

    assert.equal(result.text, 'relay text');
  });

  it('fills blank output_text from output message parts', () => {
    const handler = createHandler();
    const result = handler.extractResponse(
      {
        id: 'resp-blank-output-text',
        status: 'completed',
        output_text: '   ',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'fallback text' }],
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      } as any,
      '',
    );

    assert.equal(result.text, 'fallback text');
  });

  it('does not forge a missing end tag onto a completed response', () => {
    // The Responses API has no `stop` parameter, so a "completed" status
    // never implies the provider stripped the end tag from the output.
    // Forging it here would mask genuinely incomplete output as done.
    const handler = createHandler();
    const result = handler.extractResponse(
      {
        id: 'resp-no-end-tag',
        status: 'completed',
        output_text: 'the document body without a closing tag',
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      } as any,
      '</documents>',
    );

    assert.equal(result.text, 'the document body without a closing tag');
  });
});

describe('ModelHandlerOpenAIResponse.extractAssistantText', () => {
  it('extracts assistant text from response output text parts', () => {
    const handler = createHandler();
    const message = {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'alpha' },
        { type: 'refusal', refusal: 'skip' },
        { type: 'input_text', text: ' beta' },
      ],
    } as unknown as ResponseInputItem;

    assert.equal(handler.extractAssistantText(message), 'alpha beta');
  });

  it('ignores non-assistant message content', () => {
    const handler = createHandler();
    const message = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'not assistant text' }],
    } as unknown as ResponseInputItem;

    assert.equal(handler.extractAssistantText(message), undefined);
  });
});

describe('ModelHandlerOpenAIResponse.initializeOutputAndPrefill', () => {
  it('skips pseudo-prefill instruction when prefill is empty', async () => {
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
          '',
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
