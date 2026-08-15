// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { HTTPClient, type OpenRouter } from '@openrouter/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelProvider, ReasoningEffort } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';
import type { ResolvedClientCredential } from '@agent/types/ModelHandlerContracts';
import * as serverKeysModule from '@auth/serverKeys';
import { installTexraModelAccess } from '@controllers/modelAccess/installTexraModelAccess';
import { AgentCategory } from '@shared/schemas';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import * as providerConfigModule from '@utils/config/providerConfig';

// Type imports
import type { ChatMessages } from '@openrouter/sdk/models';

const OPENROUTER_TEST_CONFIG = Object.freeze({
  name: 'gpt-5.5',
  label: 'GPT-5.5',
  fullName: 'gpt-5.5-2026-04-15',
  shortName: 'gpt-5.5',
  provider: ModelProvider.OPENAI,
  maxOutputTokens: 16_384,
  openrouterFullName: 'openai/gpt-5.5',
});

type TestModelConfigOverrides = Parameters<typeof buildTestModelConfig>[1];

/** A logged handler pinned to the non-streaming path. */
function createHandler(
  configOverrides: TestModelConfigOverrides = {},
): ModelHandlerOpenRouterNative {
  const handler = new ModelHandlerOpenRouterNative(
    buildTestModelConfig(OPENROUTER_TEST_CONFIG, configOverrides),
  );
  handler.setLogger({ ...noopTrace });
  handler.getStreamingConfig = () => false;
  return handler;
}

/** Internals of the auxiliary compaction request path. */
type CompactionInternals = {
  runClientCompaction: (
    messages: unknown[],
    inputTokens: number,
    summarize: (
      messages: ChatMessages[],
      systemPrompt: string,
    ) => Promise<unknown>,
  ) => Promise<{ compactedMessages: ChatMessages[]; didCompact: boolean }>;
  compactConversation: (
    client: OpenRouter,
    messages: ChatMessages[],
  ) => Promise<{ compactedMessages: ChatMessages[]; didCompact: boolean }>;
};

/** Reduces compaction to the single auxiliary summarize request under test. */
function stubClientCompaction(
  handler: ModelHandlerOpenRouterNative,
): CompactionInternals {
  const target = handler as unknown as CompactionInternals;
  target.runClientCompaction = async (_messages, _inputTokens, summarize) => {
    await summarize([], 'Summarize the conversation.');
    return { compactedMessages: [], didCompact: true };
  };
  return target;
}

class CompactionProbeHandler extends ModelHandlerOpenRouterNative {
  compactForTest(
    messages: ChatMessages[],
    compact: () => Promise<{
      compactedMessages: ChatMessages[];
      didCompact: boolean;
    }>,
  ) {
    return this.maybeCompactByInputTokens(messages, 1, compact);
  }
}

function stubServerSideKeyService(): void {
  vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
    shouldUseServerSideKeysSync: () => true,
    getUseIncludedModelAccess: () => true,
    canUseServerSideKeys: async () => true,
    getRelayBaseUrl: (provider: string) =>
      `https://relay.example.com/functions/v1/relay/${provider}/v1`,
  } as unknown as ReturnType<typeof serverKeysModule.getServerSideKeyService>);
  installTexraModelAccess();
}

describe('ModelHandlerOpenRouterNative routing precedence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'returns false when getUseOpenRouter=true even if server-side keys are available',
      useOpenRouter: true,
      openRouterOnly: false,
      expected: false,
    },
    {
      name: 'returns false for openRouterOnly=true models regardless of server-side key availability',
      useOpenRouter: false,
      openRouterOnly: true,
      expected: false,
    },
    {
      name: 'respects server-side key service when NOT routing through OpenRouter',
      useOpenRouter: false,
      openRouterOnly: false,
      expected: true,
    },
  ])(
    'shouldUseServerSideKeys $name',
    ({ useOpenRouter, openRouterOnly, expected }) => {
      vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(
        useOpenRouter,
      );
      stubServerSideKeyService();

      const handler = createHandler({ openRouterOnly });

      assert.equal((handler as any).shouldUseServerSideKeys(), expected);
    },
  );
});

describe('ModelHandlerOpenRouterNative system prompt placement', () => {
  it.each([
    ModelProvider.ANTHROPIC,
    ModelProvider.GOOGLE,
    ModelProvider.OPENAI,
  ])(
    'never resupplies the system prompt per-call, even when the underlying provider is %s',
    (provider) => {
      const handler = createHandler({ provider });

      assert.equal(handler.requiresPerCallSystemPrompt, false);
    },
  );
});

describe('ModelHandlerOpenRouterNative Moonshot fixed temperature', () => {
  function createSendStub() {
    const sendCalls: any[] = [];
    return {
      sendCalls,
      client: {
        chat: {
          send: async ({ chatRequest }: { chatRequest: any }) => {
            sendCalls.push(chatRequest);
            return {
              choices: [
                {
                  message: { role: 'assistant', content: 'ok' },
                  finishReason: 'stop',
                },
              ],
              usage: { promptTokens: 100, completionTokens: 10 },
            };
          },
        },
      },
    };
  }

  it('omits temperature for Kimi K3 routed through OpenRouter', async () => {
    // Same rule as the direct Moonshot path: K3 fixes sampling server-side
    // and requires requests to omit temperature. OpenRouter forwards to the
    // same backend, so the field must not survive this route either.
    const handler = createHandler({
      name: 'kimi3',
      fullName: 'kimi-k3',
      openrouterFullName: 'moonshotai/kimi-k3',
      provider: ModelProvider.MOONSHOT,
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffort: ReasoningEffort.MAX,
      },
    });

    const { client, sendCalls } = createSendStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'think' }],
      temperature: 0,
    });

    assert.equal('temperature' in sendCalls[0], false);
  });

  it('keeps the caller temperature outside Moonshot', async () => {
    const handler = createHandler({
      fullName: 'kimi-k3',
      provider: ModelProvider.OPENAI,
    });

    const { client, sendCalls } = createSendStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
    });

    assert.equal(sendCalls[0].temperature, 0.3);
  });

  it('maps finalTool to a named OpenRouter function choice', async () => {
    const handler = createHandler();
    const { client, sendCalls } = createSendStub();

    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'finish' }],
      temperature: 0,
      tools: [{ name: 'submit_output', description: 'Submit output' }],
      finalTool: { name: 'submit_output' },
    });

    assert.deepEqual(sendCalls[0].toolChoice, {
      type: 'function',
      function: { name: 'submit_output' },
    });
    assert.equal(handler.supportsForcedToolChoice, true);
  });
});

describe('ModelHandlerOpenRouterNative forced tool choice', () => {
  it.each([
    {
      name: 'disables forcing for reasoning DeepSeek models',
      provider: ModelProvider.DEEPSEEK,
      supportsReasoning: true,
      expected: false,
    },
    {
      name: 'keeps forcing for non-reasoning DeepSeek models',
      provider: ModelProvider.DEEPSEEK,
      supportsReasoning: false,
      expected: true,
    },
    {
      name: 'keeps forcing for reasoning models from other providers',
      provider: ModelProvider.OPENAI,
      supportsReasoning: true,
      expected: true,
    },
  ])('$name', ({ provider, supportsReasoning, expected }) => {
    const handler = createHandler({
      provider,
      capabilities: { supportsReasoning },
    });

    assert.equal(handler.supportsForcedToolChoice, expected);
  });
});

describe('ModelHandlerOpenRouterNative response mode discrimination', () => {
  it.each([
    {
      name: 'rejects a non-streaming response on the streaming path',
      streaming: true,
      send: async () => ({
        choices: [],
        created: 0,
        id: 'response-id',
        model: 'openai/gpt-5.5',
        object: 'chat.completion',
        usage: null,
      }),
      error: /non-streaming response for a streaming request/,
    },
    {
      name: 'rejects a streaming response on the non-streaming path',
      streaming: false,
      send: async () => ({
        async *[Symbol.asyncIterator]() {
          yield { choices: [] };
        },
      }),
      error: /streaming response for a non-streaming request/,
    },
  ])('$name', async ({ streaming, send, error }) => {
    const handler = createHandler();
    handler.getStreamingConfig = () => streaming;
    const client = { chat: { send } };

    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      }),
      error,
    );
  });
});

describe('ModelHandlerOpenRouterNative reasoning-level override', () => {
  it('does not allow overrides for a fixed max-effort model', () => {
    const handler = createHandler({
      provider: ModelProvider.MOONSHOT,
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffort: ReasoningEffort.MAX,
      },
    });

    assert.equal(handler.supportsReasoningLevelOverride, false);
  });

  it('allows max selection when the model declares max as its ceiling', () => {
    const handler = createHandler({
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffort: ReasoningEffort.MEDIUM,
        maxReasoningEffort: ReasoningEffort.MAX,
      },
    });

    assert.equal(handler.supportsReasoningLevelOverride, true);
  });

  it('keeps the declared override range after an effective max selection', () => {
    const handler = createHandler({
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffort: ReasoningEffort.XHIGH,
      },
    });
    handler.capabilities.reasoningEffort = ReasoningEffort.MAX;

    assert.equal(handler.supportsReasoningLevelOverride, true);
  });

  it.each([
    {
      name: 'DeepSeek (via OpenRouter) with reasoning but no granular effort control',
      provider: ModelProvider.DEEPSEEK,
      supportsReasoning: true,
      supportsReasoningEffort: false,
      expected: true,
    },
    {
      name: 'non-DeepSeek provider without granular effort control',
      provider: ModelProvider.ANTHROPIC,
      supportsReasoning: true,
      supportsReasoningEffort: false,
      expected: false,
    },
    {
      name: 'any provider with granular effort control',
      provider: ModelProvider.OPENAI,
      supportsReasoning: false,
      supportsReasoningEffort: true,
      expected: true,
    },
  ])(
    '$name',
    ({ provider, supportsReasoning, supportsReasoningEffort, expected }) => {
      const handler = createHandler({
        provider,
        capabilities: {
          supportsReasoning,
          supportsReasoningEffort,
        },
      });

      assert.equal(handler.supportsReasoningLevelOverride, expected);
    },
  );

  it('preserves xhigh for xAI models routed through OpenRouter', () => {
    class TestableHandler extends ModelHandlerOpenRouterNative {
      validateReasoningEffortForTest(effort: string): string {
        return this.validateReasoningEffort(effort);
      }
    }

    const handler = new TestableHandler(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG, {
        provider: ModelProvider.XAI,
      }),
    );

    assert.equal(handler.validateReasoningEffortForTest('xhigh'), 'xhigh');
  });
});

describe('ModelHandlerOpenRouterNative getClient retry policy', () => {
  it('uses the long-running transport, disables SDK retries, and records the endpoint', async () => {
    const endpoint = 'https://openrouter.example/v1';
    const transportFetch = vi.fn<typeof fetch>();
    class TestableHandler extends ModelHandlerOpenRouterNative {
      protected override get longRunningModelFetch(): typeof fetch {
        return transportFetch;
      }

      protected override async resolveClientCredential(): Promise<ResolvedClientCredential> {
        return {
          apiKey: 'test-api-key',
          baseUrl: endpoint,
          route: 'openrouter',
        };
      }
    }

    const handler = new TestableHandler(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG),
    );
    const client = await handler.getClient();

    // Constructing the SDK client is synchronous, local option-merging (no
    // network call), so inspecting the stored options is safe here.
    // Reaches into the SDK client's private `_options` (no public accessor).
    // A future @openrouter/sdk bump renaming it makes `options` undefined and
    // the deepEqual below throw — a loud failure, not silent under-assertion.
    // Re-check this access on SDK bumps.
    const options = (client as unknown as { _options: Record<string, unknown> })
      ._options;

    assert.deepEqual(options.retryConfig, { strategy: 'none' });
    // ClientSDK normalizes its public _baseURL with a trailing slash.
    assert.equal(handler.getRetryEndpoint(client), `${endpoint}/`);

    transportFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const request = new Request(`${endpoint}/models`);
    const response = await (options.httpClient as HTTPClient).request(request);
    assert.equal(response.status, 204);
    assert.equal(transportFetch.mock.calls.length, 1);
    assert.equal(transportFetch.mock.calls[0]?.[0], request);
  });
});

describe('ModelHandlerOpenRouterNative compaction retries', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createCompactionTarget(): CompactionInternals {
    return stubClientCompaction(
      new ModelHandlerOpenRouterNative(
        buildTestModelConfig(OPENROUTER_TEST_CONFIG),
      ),
    );
  }

  function transientProviderError(): Error {
    return Object.assign(new Error('provider unavailable'), { status: 503 });
  }

  it('retries a transient auxiliary compaction request twice', async () => {
    vi.useFakeTimers();
    const target = createCompactionTarget();
    const transient = transientProviderError();
    const send = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'summary' } }],
        usage: { completionTokens: 1 },
      });

    const result = target.compactConversation(
      { chat: { send } } as unknown as OpenRouter,
      [],
    );
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({
      compactedMessages: [],
      didCompact: true,
    });
    assert.equal(send.mock.calls.length, 3);
  });

  it('does not retry a compaction credential failure', async () => {
    const target = createCompactionTarget();
    const credentialFailure = Object.assign(new Error('invalid credential'), {
      status: 401,
    });
    const send = vi.fn().mockRejectedValue(credentialFailure);

    await expect(
      target.compactConversation(
        { chat: { send } } as unknown as OpenRouter,
        [],
      ),
    ).rejects.toBe(credentialFailure);
    expect(send).toHaveBeenCalledOnce();
  });

  it('reuses successful compaction until generation succeeds', async () => {
    const handler = new CompactionProbeHandler(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG),
    );
    handler.setAgentCategory(AgentCategory.ToolUse);
    vi.spyOn(handler, 'getStreamingConfig').mockReturnValue(false);

    const messages: ChatMessages[] = [
      { role: 'user', content: 'original conversation' },
    ];
    const compactedMessages: ChatMessages[] = [
      { role: 'user', content: 'compacted conversation' },
    ];
    const compact = vi.fn(async () => ({
      compactedMessages,
      didCompact: true,
    }));

    handler.requestCompaction();
    await handler.compactForTest(messages, compact);

    const transient = transientProviderError();
    const send = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finishReason: 'stop',
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      });
    const client = { chat: { send } } as unknown as OpenRouter;
    const options = { client, messages, temperature: 0 };

    await expect(handler.createResponse(options)).rejects.toBe(transient);
    await expect(handler.createResponse(options)).resolves.toMatchObject({
      updatedMessages: compactedMessages,
    });

    expect(compact).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
    for (const [request] of send.mock.calls) {
      expect(request.chatRequest.messages).toBe(compactedMessages);
    }

    const nextCompact = vi.fn(async () => ({
      compactedMessages,
      didCompact: true,
    }));
    handler.requestCompaction();
    await handler.compactForTest(messages, nextCompact);
    expect(nextCompact).toHaveBeenCalledOnce();
  });

  it('drops a pending compaction when a follow-up mutates the same array', async () => {
    // Regression: after a failed turn the root tool-use flow appends the
    // user's follow-up IN PLACE onto the same messages array. Reference
    // identity alone would replay the stale pre-follow-up payload and
    // silently drop the follow-up from the request and — via the flow's
    // in-place commit — from the conversation history.
    const handler = new CompactionProbeHandler(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG),
    );
    handler.setAgentCategory(AgentCategory.ToolUse);
    vi.spyOn(handler, 'getStreamingConfig').mockReturnValue(false);
    const messages: ChatMessages[] = [
      { role: 'user', content: 'original conversation' },
    ];
    const compact = vi.fn(async () => ({
      compactedMessages: [
        { role: 'user' as const, content: 'compacted conversation' },
      ],
      didCompact: true,
    }));

    handler.requestCompaction();
    await handler.compactForTest(messages, compact);
    expect(compact).toHaveBeenCalledOnce();

    // Push-style follow-up (OpenAI/OpenRouter shape): length changes.
    messages.push({ role: 'user', content: 'follow-up after failure' });
    handler.requestCompaction();
    await handler.compactForTest(messages, compact);
    expect(compact).toHaveBeenCalledTimes(2);

    // Merge-style follow-up (Google Interactions shape): same length, the
    // last message mutates in place.
    const last = messages.at(-1) as { role: 'user'; content: string };
    last.content += ' with merged continuation';
    handler.requestCompaction();
    await handler.compactForTest(messages, compact);
    expect(compact).toHaveBeenCalledTimes(3);
  });
});
