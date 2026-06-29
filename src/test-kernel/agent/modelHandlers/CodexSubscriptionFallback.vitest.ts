import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';

import { ModelHandlerCodex } from '@agent/modelHandlers/openai/modelHandlerCodex';
import {
  CODEX_BACKEND_BASE_URL,
  CODEX_SUBSCRIPTION_CONTEXT_WINDOW,
  resetCodexCoordinator,
  setPreferCodexSubscription,
} from '@auth/codex';
import { setServerSideKeyService } from '@auth/serverKeys';
import { AgentCategory } from '@shared/schemas/agent';

import type { ResponseUsage } from 'openai/resources/responses/responses';

// Dynamic import keeps `initPlatform` out of the static import graph (it is
// restricted to composition roots); the routing tests use the same pattern.
async function initFakePlatformWithSubscription(
  extraConfig: Record<string, unknown> = {},
): Promise<void> {
  const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/FakePlatform'),
  ]);
  initPlatform(
    createFakePlatform({
      config: {
        'texra.chatgptCodex.preferSubscription': true,
        ...extraConfig,
      },
    }),
  );
}

const config: ModelConfig = {
  name: 'gpt55-test',
  label: 'GPT-5.5',
  fullName: 'gpt-5.5',
  shortName: 'gpt-5.5',
  provider: ModelProvider.OPENAI,
  maxOutputTokens: 1024,
  inputPrice: 2,
  outputPrice: 8,
  contextWindow: 128_000,
  capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
  openRouterOnly: false,
};

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

describe('ModelHandlerCodex subscription fallback', () => {
  beforeEach(() => {
    // The fallback path resolves the OpenAI base via the relay service; stub it
    // to "no relay" so getBaseUrl() yields the direct OpenAI base.
    setServerSideKeyService({
      shouldUseServerSideKeysSync: () => false,
    } as never);
  });

  afterEach(() => {
    resetCodexCoordinator();
  });

  it('targets the Codex backend and zero-rates usage while the preference is on', async () => {
    await initFakePlatformWithSubscription();

    const handler = new ModelHandlerCodex(config);
    expect(handler.getBaseUrl()).toBe(CODEX_BACKEND_BASE_URL);
    expect(handler.computePrice(ONE_MILLION_INPUT_TOKENS)).toBe(0);
  });

  it('falls back to the OpenAI API-key path when the preference is turned off mid-run', async () => {
    await initFakePlatformWithSubscription();

    const handler = new ModelHandlerCodex(config);
    expect(handler.getBaseUrl()).toBe(CODEX_BACKEND_BASE_URL);

    // The "Use your own API key" switch flips this preference; the same handler
    // instance must reroute on the next request without being recreated.
    await setPreferCodexSubscription(false);

    expect(handler.getBaseUrl()).not.toBe(CODEX_BACKEND_BASE_URL);
    expect(handler.computePrice(ONE_MILLION_INPUT_TOKENS)).toBeGreaterThan(0);
  });

  it('clamps the effective context window to the Codex ceiling while the preference is on', async () => {
    await initFakePlatformWithSubscription();

    const handler = new ModelHandlerCodex(largeWindowConfig);
    // The model's own 1.05M API window must not leak through on the
    // subscription path, where the backend rejects requests past the ceiling.
    expect(handler.getEffectiveContextWindow()).toBe(
      CODEX_SUBSCRIPTION_CONTEXT_WINDOW,
    );
  });

  it('restores the full model window after falling back to the API key', async () => {
    await initFakePlatformWithSubscription();

    const handler = new ModelHandlerCodex(largeWindowConfig);
    expect(handler.getEffectiveContextWindow()).toBe(
      CODEX_SUBSCRIPTION_CONTEXT_WINDOW,
    );

    // "Use your own API key" routes to the real OpenAI API, which honors the
    // model's full declared window.
    await setPreferCodexSubscription(false);

    expect(handler.getEffectiveContextWindow()).toBe(1_050_000);
  });

  it('leaves a model whose window is already below the ceiling untouched', async () => {
    await initFakePlatformWithSubscription();

    // The clamp is a floor (Math.min), so a sub-ceiling window is unchanged.
    const handler = new ModelHandlerCodex(config);
    expect(handler.getEffectiveContextWindow()).toBe(config.contextWindow);
  });

  it('keeps tool-use agents on the subscription while the tool-use-only switch is on', async () => {
    await initFakePlatformWithSubscription();

    const handler = new ModelHandlerCodex(config);
    handler.setAgentCategory(AgentCategory.ToolUse);

    expect(handler.getBaseUrl()).toBe(CODEX_BACKEND_BASE_URL);
    expect(handler.computePrice(ONE_MILLION_INPUT_TOKENS)).toBe(0);
  });

  it('routes workflow agents to the API-key path while the tool-use-only switch is on (default)', async () => {
    await initFakePlatformWithSubscription();

    // The Codex backend has no background mode and is less stable for long
    // runs, so workflow agents must skip the subscription by default.
    const handler = new ModelHandlerCodex(largeWindowConfig);
    handler.setAgentCategory(AgentCategory.Workflow);

    expect(handler.getBaseUrl()).not.toBe(CODEX_BACKEND_BASE_URL);
    expect(handler.computePrice(ONE_MILLION_INPUT_TOKENS)).toBeGreaterThan(0);
    // Falling back to the API key also restores the model's full window.
    expect(handler.getEffectiveContextWindow()).toBe(1_050_000);
  });

  it('keeps workflow agents on the subscription when the tool-use-only switch is off', async () => {
    await initFakePlatformWithSubscription({
      'texra.chatgptCodex.subscriptionToolUseOnly': false,
    });

    const handler = new ModelHandlerCodex(config);
    handler.setAgentCategory(AgentCategory.Workflow);

    expect(handler.getBaseUrl()).toBe(CODEX_BACKEND_BASE_URL);
    expect(handler.computePrice(ONE_MILLION_INPUT_TOKENS)).toBe(0);
  });

  it('tags normalized usage as a free subscription round while the preference is on', async () => {
    await initFakePlatformWithSubscription();

    const handler = new ModelHandlerCodex(config);
    const usage = handler.normalizeUsage(RAW_USAGE, 1000);

    // Recorded (tokens present) but free and marked, so logging/UI can tell it
    // apart from any other zero-cost row.
    expect(usage.viaChatGptSubscription).toBe(true);
    expect(usage.cost).toBe(0);
    expect(usage.inputTokens).toBe(1_000_000);
  });

  it('drops the free tag and bills normally after falling back to the API key', async () => {
    await initFakePlatformWithSubscription();

    const handler = new ModelHandlerCodex(config);
    await setPreferCodexSubscription(false);
    const usage = handler.normalizeUsage(RAW_USAGE, 1000);

    expect(usage.viaChatGptSubscription).toBeUndefined();
    expect(usage.cost).toBeGreaterThan(0);
  });
});
