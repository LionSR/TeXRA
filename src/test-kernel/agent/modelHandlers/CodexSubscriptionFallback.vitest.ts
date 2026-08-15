import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pDefer from 'p-defer';
import { ModelProvider, ReasoningEffort, type ModelConfig } from 'llm-zoo';

import { ModelHandlerCodex } from '@agent/modelHandlers/openai/modelHandlerCodex';
import type { ModelCredentialRoute } from '@agent/types/ModelHandlerContracts';
import { CODEX_BACKEND_BASE_URL, resetCodexCoordinator } from '@auth/codex';
import { setServerSideKeyService } from '@auth/serverKeys';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import {
  CODEX_DEFAULT_SUBSCRIPTION_CONTEXT_WINDOW,
  CODEX_DEFAULT_SUBSCRIPTION_INPUT_LIMIT,
} from '@model/providerCapabilities';
import {
  setPreferCodexSubscription,
  isPreferCodexSubscription,
} from '@model/codex/codexPreference';
import { AgentCategory } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

import type OpenAI from 'openai';
import type { ResponseUsage } from 'openai/resources/responses/responses';

function initFakePlatformWithSubscription(): Promise<void> {
  return installPlatform({
    config: {
      'texra.chatgptCodex.preferSubscription': true,
    },
    secrets: { [apiKeySecretName('openai')]: 'sk-openai-test' },
  });
}

const config: ModelConfig = buildTestModelConfig({
  name: 'gpt55-test',
  label: 'GPT-5.5',
  fullName: 'gpt-5.5',
  shortName: 'gpt-5.5',
  provider: ModelProvider.OPENAI,
  maxOutputTokens: 1024,
  inputPrice: 2,
  outputPrice: 8,
  contextWindow: 128_000,
  // Codex eligibility comes from the registry's codexSubscription flag
  // (see providerCapabilities.ts), not from tier/naming heuristics.
  capabilities: {
    reasoningEffort: ReasoningEffort.XHIGH,
  },
  openRouterOnly: false,
  codexSubscription: true,
});

// gpt-5.5 declares a 1,050,000-token window over the OpenAI API, but the Codex
// subscription backend enforces a far smaller ceiling — the override must clamp
// the effective window to that ceiling while the subscription drives requests.
const largeWindowConfig: ModelConfig = {
  ...config,
  contextWindow: 1_050_000,
};

const ONE_MILLION_INPUT_TOKENS = {
  input_tokens: 1_000_000,
  output_tokens: 0,
} as ResponseUsage;

const RAW_USAGE = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
} as ResponseUsage;

class CodexRouteProbe extends ModelHandlerCodex {
  tagClient(client: OpenAI, route: ModelCredentialRoute): OpenAI {
    return this.rememberClientCredentialRoute(client, route, 'test-credential');
  }
}

/** Seed the handler's running input-token tally (owned by the chain-state
 *  collaborator; reached here via its narrow setter, not a raw field write). */
function setCumulativeInputTokens(
  handler: ModelHandlerCodex,
  tokens: number,
): void {
  (
    handler as unknown as {
      chainState: { setCumulativeInputTokens(tokens: number): void };
    }
  ).chainState.setCumulativeInputTokens(tokens);
}

/** The subscription path drives the Codex backend and zero-rates usage. */
function expectOnSubscription(handler: ModelHandlerCodex): void {
  expect(handler.getBaseUrl()).toBe(CODEX_BACKEND_BASE_URL);
  expect(handler.computePrice(ONE_MILLION_INPUT_TOKENS)).toBe(0);
}

describe('ModelHandlerCodex subscription fallback', () => {
  beforeEach(() => {
    // The fallback path resolves the OpenAI base via the relay service; stub it
    // to "no relay" so getBaseUrl() yields the direct OpenAI base.
    setServerSideKeyService({
      getUseIncludedModelAccess: () => false,
      canUseServerSideKeys: async () => false,
      wasQuotaAutoSwitched: () => false,
      shouldUseServerSideKeysSync: () => false,
    } as never);
    invalidateApiKeyCache();
  });

  afterEach(() => {
    resetCodexCoordinator();
  });

  async function newSubscriptionHandler(
    modelConfig: ModelConfig = config,
    category: AgentCategory = AgentCategory.ToolUse,
  ): Promise<ModelHandlerCodex> {
    await initFakePlatformWithSubscription();
    const handler = new ModelHandlerCodex(modelConfig);
    handler.setAgentCategory(category);
    return handler;
  }

  it('targets the Codex backend and zero-rates usage while the preference is on', async () => {
    const handler = await newSubscriptionHandler();

    expectOnSubscription(handler);
  });

  it('falls back to the OpenAI API-key path when the preference is turned off mid-run', async () => {
    const handler = await newSubscriptionHandler();
    expectOnSubscription(handler);

    // The "Use your own API key" switch flips this preference; the same handler
    // instance must reroute on the next request without being recreated.
    await setPreferCodexSubscription(false);

    expect(handler.getBaseUrl()).not.toBe(CODEX_BACKEND_BASE_URL);
    expect(handler.computePrice(ONE_MILLION_INPUT_TOKENS)).toBeGreaterThan(0);
  });

  it('clamps the effective context window to the Codex ceiling while the preference is on', async () => {
    const handler = await newSubscriptionHandler(largeWindowConfig);

    // The model's own 1.05M API window must not leak through on the
    // subscription path, where the backend rejects requests past the ceiling.
    expect(handler.getEffectiveContextWindow()).toBe(
      CODEX_DEFAULT_SUBSCRIPTION_CONTEXT_WINDOW,
    );
  });

  it('restores the full model window after falling back to the API key', async () => {
    const handler = await newSubscriptionHandler(largeWindowConfig);
    expect(handler.getEffectiveContextWindow()).toBe(
      CODEX_DEFAULT_SUBSCRIPTION_CONTEXT_WINDOW,
    );

    // "Use your own API key" routes to the real OpenAI API, which honors the
    // model's full declared window.
    await setPreferCodexSubscription(false);

    expect(handler.getEffectiveContextWindow()).toBe(1_050_000);
  });

  it('leaves a model whose window is already below the ceiling untouched', async () => {
    // The clamp is a cap (Math.min), so a sub-ceiling window is unchanged.
    const handler = await newSubscriptionHandler();

    expect(handler.getEffectiveContextWindow()).toBe(config.contextWindow);
  });

  it('keeps untagged helper handlers on the subscription', async () => {
    await initFakePlatformWithSubscription();

    const handler = new ModelHandlerCodex(config);

    expectOnSubscription(handler);
  });

  it.each([
    { headroom: 10, error: /route input limit/ },
    { headroom: 100, error: /safety buffer/ },
  ])(
    'rejects locally without sending when cumulative input leaves $headroom tokens of headroom',
    async ({ headroom, error }) => {
      const handler = await newSubscriptionHandler(largeWindowConfig);
      const requestSpy = vi.fn();
      setCumulativeInputTokens(
        handler,
        CODEX_DEFAULT_SUBSCRIPTION_INPUT_LIMIT - headroom,
      );

      await expect(
        handler.createResponse({
          client: { responses: { create: requestSpy } } as never,
          messages: [],
          temperature: 0,
        }),
      ).rejects.toThrow(error);
      expect(requestSpy).not.toHaveBeenCalled();
    },
  );

  it('keeps workflow agents on the subscription', async () => {
    const handler = await newSubscriptionHandler(
      config,
      AgentCategory.Workflow,
    );

    expectOnSubscription(handler);
  });

  it('tags normalized usage with the subscription route while the preference is on', async () => {
    const handler = await newSubscriptionHandler();

    const usage = handler.normalizeUsage(RAW_USAGE, 1000);

    // Recorded (tokens present) but free and routed, so logging/UI can tell it
    // apart from any other zero-cost row.
    expect(usage.usageRoute).toBe('chatgpt-subscription');
    expect(usage.cost).toBe(0);
    expect(usage.inputTokens).toBe(1_000_000);
  });

  it('drops the free tag and bills normally after falling back to the API key', async () => {
    const handler = await newSubscriptionHandler();
    await setPreferCodexSubscription(false);

    const usage = handler.normalizeUsage(RAW_USAGE, 1000);

    expect(usage.usageRoute).toBeUndefined();
    expect(usage.cost).toBeGreaterThan(0);
  });

  it('keeps an in-flight attempt on its captured subscription route', async () => {
    await initFakePlatformWithSubscription();

    const handler = new CodexRouteProbe(largeWindowConfig);
    handler.setAgentCategory(AgentCategory.ToolUse);
    const stream = pDefer<never>();
    const streamRequest = vi.fn(() => stream.promise);
    const client = handler.tagClient(
      { responses: { stream: streamRequest } } as unknown as OpenAI,
      'chatgpt-subscription',
    );

    const attempt = handler.createResponse({
      client,
      messages: [],
      temperature: 0,
    });
    await vi.waitFor(() => expect(streamRequest).toHaveBeenCalledOnce());

    await setPreferCodexSubscription(false);
    expect(handler.getEffectiveContextWindow()).toBe(
      CODEX_DEFAULT_SUBSCRIPTION_CONTEXT_WINDOW,
    );
    expect(handler.computePrice(RAW_USAGE)).toBe(0);
    expect(handler.getLastCredentialUsageRoute()).toBe('chatgpt-subscription');

    const rejectedClient = handler.tagClient(
      { responses: { stream: vi.fn() } } as unknown as OpenAI,
      'api-key',
    );
    await expect(
      handler.createResponse({
        client: rejectedClient,
        messages: [],
        temperature: 0,
      }),
    ).rejects.toThrow(/single-turn per instance/);
    expect(handler.getLastCredentialUsageRoute()).toBe('chatgpt-subscription');

    stream.reject(new Error('finish route snapshot test'));
    await expect(attempt).rejects.toThrow('finish route snapshot test');
    expect(handler.getBaseUrl()).not.toBe(CODEX_BACKEND_BASE_URL);
    expect(handler.getEffectiveContextWindow()).toBe(
      largeWindowConfig.contextWindow,
    );
    expect(handler.computePrice(RAW_USAGE)).toBe(0);
    expect(handler.normalizeUsage(RAW_USAGE, 1000)).toMatchObject({
      cost: 0,
      usageRoute: 'chatgpt-subscription',
    });
  });

  it('constructs a personal candidate without publishing the preference', async () => {
    const handler = await newSubscriptionHandler();

    const candidate = await handler.getClient('personal');

    expect(candidate.baseURL).toBe('https://api.openai.com/v1');
    expect(isPreferCodexSubscription()).toBe(true);
  });
});
