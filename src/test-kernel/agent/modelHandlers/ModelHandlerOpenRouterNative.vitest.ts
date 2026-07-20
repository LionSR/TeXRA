// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import {
  ConnectionError as OpenRouterConnectionError,
  RequestTimeoutError as OpenRouterRequestTimeoutError,
} from '@openrouter/sdk/models/errors';
import { describe, it, afterEach, vi } from 'vitest';
import { ModelProvider, ReasoningEffort } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';
import type { ResolvedClientCredential } from '@agent/types/ModelHandlerContracts';

// Modules to stub via vi.spyOn
import * as serverKeysModule from '@auth/serverKeys';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import * as providerConfigModule from '@utils/config/providerConfig';

const OPENROUTER_TEST_CONFIG = Object.freeze({
  name: 'gpt-5.5',
  label: 'GPT-5.5',
  fullName: 'gpt-5.5-2026-04-15',
  shortName: 'gpt-5.5',
  provider: ModelProvider.OPENAI,
  maxOutputTokens: 16_384,
  openrouterFullName: 'openai/gpt-5.5',
});

function stubServerSideKeyService(): void {
  vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
    shouldUseServerSideKeysSync: () => true,
    getUseIncludedModelAccess: () => true,
    canUseServerSideKeys: async () => true,
    getRelayBaseUrl: (provider: string) =>
      `https://relay.example.com/functions/v1/relay/${provider}/v1`,
  } as unknown as ReturnType<typeof serverKeysModule.getServerSideKeyService>);
}

function statusError(statusCode: number): Error {
  return Object.assign(new Error(`OpenRouter HTTP ${statusCode}`), {
    statusCode,
  });
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

      const handler = new ModelHandlerOpenRouterNative(
        buildTestModelConfig(OPENROUTER_TEST_CONFIG, { openRouterOnly }),
      );

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
      const handler = new ModelHandlerOpenRouterNative(
        buildTestModelConfig(OPENROUTER_TEST_CONFIG, { provider }),
      );

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
    const handler = new ModelHandlerOpenRouterNative(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG, {
        name: 'kimi3',
        fullName: 'kimi-k3',
        openrouterFullName: 'moonshotai/kimi-k3',
        provider: ModelProvider.MOONSHOT,
        capabilities: {
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.MAX,
        },
      }),
    );
    (handler as any).setLogger({ ...noopTrace });
    (handler as any).getStreamingConfig = () => false;

    const { client, sendCalls } = createSendStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'think' }],
      temperature: 0,
    });

    assert.equal('temperature' in sendCalls[0], false);
  });

  it('keeps the caller temperature outside Moonshot', async () => {
    const handler = new ModelHandlerOpenRouterNative(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG, {
        fullName: 'kimi-k3',
        provider: ModelProvider.OPENAI,
      }),
    );
    (handler as any).setLogger({ ...noopTrace });
    (handler as any).getStreamingConfig = () => false;

    const { client, sendCalls } = createSendStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
    });

    assert.equal(sendCalls[0].temperature, 0.3);
  });

  it('maps finalTool to a named OpenRouter function choice', async () => {
    const handler = new ModelHandlerOpenRouterNative(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG),
    );
    (handler as any).setLogger({ ...noopTrace });
    (handler as any).getStreamingConfig = () => false;
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

describe('ModelHandlerOpenRouterNative response mode discrimination', () => {
  it('rejects a non-streaming response on the streaming path', async () => {
    const handler = new ModelHandlerOpenRouterNative(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG),
    );
    (handler as any).setLogger({ ...noopTrace });
    (handler as any).getStreamingConfig = () => true;

    const client = {
      chat: {
        send: async () => ({
          choices: [],
          created: 0,
          id: 'response-id',
          model: 'openai/gpt-5.5',
          object: 'chat.completion',
          usage: null,
        }),
      },
    };

    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      }),
      /non-streaming response for a streaming request/,
    );
  });

  it('rejects a streaming response on the non-streaming path', async () => {
    const handler = new ModelHandlerOpenRouterNative(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG),
    );
    (handler as any).setLogger({ ...noopTrace });
    (handler as any).getStreamingConfig = () => false;

    const client = {
      chat: {
        send: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { choices: [] };
          },
        }),
      },
    };

    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      }),
      /streaming response for a non-streaming request/,
    );
  });
});

describe('ModelHandlerOpenRouterNative reasoning-level override', () => {
  it('does not allow overrides for a fixed max-effort model', () => {
    const handler = new ModelHandlerOpenRouterNative(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG, {
        provider: ModelProvider.MOONSHOT,
        capabilities: {
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.MAX,
        },
      }),
    );

    assert.equal(handler.supportsReasoningLevelOverride, false);
  });

  it('allows max selection when the model declares max as its ceiling', () => {
    const handler = new ModelHandlerOpenRouterNative(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG, {
        capabilities: {
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.MEDIUM,
          maxReasoningEffort: ReasoningEffort.MAX,
        },
      }),
    );

    assert.equal(handler.supportsReasoningLevelOverride, true);
  });

  it('keeps the declared override range after an effective max selection', () => {
    const handler = new ModelHandlerOpenRouterNative(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG, {
        capabilities: {
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.XHIGH,
        },
      }),
    );
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
      const handler = new ModelHandlerOpenRouterNative(
        buildTestModelConfig(OPENROUTER_TEST_CONFIG, {
          provider,
          capabilities: {
            supportsReasoning,
            supportsReasoningEffort,
          },
        }),
      );

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

describe('ModelHandlerOpenRouterNative retry ownership', () => {
  it('matches the OpenRouter SDK retry boundary', () => {
    const handler = new ModelHandlerOpenRouterNative(
      buildTestModelConfig(OPENROUTER_TEST_CONFIG),
    );

    assert.equal(handler.isAutoRetryManagedByProvider(statusError(500)), true);
    assert.equal(handler.isAutoRetryManagedByProvider(statusError(529)), true);
    assert.equal(handler.isAutoRetryManagedByProvider(statusError(429)), false);
    assert.equal(handler.isAutoRetryManagedByProvider(statusError(408)), false);
    assert.equal(
      handler.isAutoRetryManagedByProvider(
        new OpenRouterConnectionError('connection failed'),
      ),
      true,
    );
    assert.equal(
      handler.isAutoRetryManagedByProvider(
        new OpenRouterRequestTimeoutError('request timed out'),
      ),
      true,
    );
  });
});

describe('ModelHandlerOpenRouterNative getClient retryConfig', () => {
  it('bounds the SDK retry window instead of the 1h default (#7643)', async () => {
    class TestableHandler extends ModelHandlerOpenRouterNative {
      protected override async resolveClientCredential(): Promise<ResolvedClientCredential> {
        return {
          apiKey: 'test-api-key',
          baseUrl: null,
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

    assert.deepEqual(options.retryConfig, {
      strategy: 'backoff',
      backoff: {
        initialInterval: 500,
        maxInterval: 8_000,
        exponent: 1.5,
        maxElapsedTime: 30_000,
      },
      retryConnectionErrors: true,
    });
  });
});
