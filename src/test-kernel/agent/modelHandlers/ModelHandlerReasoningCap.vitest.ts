// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, afterEach, vi } from 'vitest';
import { type ModelConfig, ModelProvider, ReasoningEffort } from 'llm-zoo';

// Local imports - handler under test (concrete subclass exercising base-class
// `getEffectiveReasoningEffort` — OpenRouterNative does not override it)
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';
import { FREE_TIER, MAX_TIER, ULTRA_TIER } from '@auth/config';
import * as serverKeysModule from '@auth/serverKeys';
import { installTexraModelAccess } from '@controllers/modelAccess/installTexraModelAccess';
import { setIncludedModelAccess } from '@model/includedModelAccess';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

// Modules to stub via vi.spyOn
import * as providerConfigModule from '@utils/config/providerConfig';

function buildGpt5Config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return buildTestModelConfig(
    {
      name: 'gpt5-mini',
      label: 'GPT-5 Mini',
      fullName: 'gpt-5-mini-2025-08-15',
      shortName: 'gpt5-mini',
      provider: ModelProvider.OPENAI,
      maxOutputTokens: 16384,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 200000,
      capabilities: {
        supportsReasoningEffort: true,
        reasoningEffort: ReasoningEffort.XHIGH,
      },
      openRouterOnly: false,
      openrouterFullName: 'openai/gpt-5-mini',
    },
    overrides,
  );
}

// The caps are TeXRA's relay pricing policy, so they are asserted through the
// installed provider the three hosts actually install — the handler itself only
// asks whether the route is capped.
describe('ModelHandler.getEffectiveReasoningEffort tier caps', () => {
  function effectiveReasoningEffort(
    handler: ModelHandlerOpenRouterNative,
  ): ReasoningEffort | null {
    return (
      handler as unknown as {
        getEffectiveReasoningEffort(): ReasoningEffort | null;
      }
    ).getEffectiveReasoningEffort();
  }

  function stubServerSideKeys(
    tier: string | null,
    useServerSideKeys = true,
  ): void {
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(false);

    vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
      shouldUseServerSideKeysSync: () => useServerSideKeys,
      getUserTier: () => tier,
      getUseIncludedModelAccess: () => useServerSideKeys,
      canUseServerSideKeys: async () => useServerSideKeys,
      getRelayBaseUrl: (provider: string) =>
        `https://relay.example.com/functions/v1/relay/${provider}/v1`,
    } as unknown as ReturnType<
      typeof serverKeysModule.getServerSideKeyService
    >);
    installTexraModelAccess();
  }

  afterEach(() => {
    setIncludedModelAccess(null);
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'caps xhigh to medium for free tier on GPT-5 with server-side keys',
      tier: FREE_TIER,
      expected: ReasoningEffort.MEDIUM,
    },
    {
      name: 'caps xhigh to high for Max tier on GPT-5 with server-side keys',
      tier: MAX_TIER,
      expected: ReasoningEffort.HIGH,
    },
    {
      name: 'does not cap xhigh for Ultra tier on GPT-5 with server-side keys',
      tier: ULTRA_TIER,
      expected: ReasoningEffort.XHIGH,
    },
  ])('$name', ({ tier, expected }) => {
    stubServerSideKeys(tier);
    const handler = new ModelHandlerOpenRouterNative(buildGpt5Config());
    assert.equal(effectiveReasoningEffort(handler), expected);
  });

  it('does not cap when not using server-side keys (free tier, own key)', () => {
    stubServerSideKeys(FREE_TIER, false);

    const handler = new ModelHandlerOpenRouterNative(buildGpt5Config());
    assert.equal(effectiveReasoningEffort(handler), ReasoningEffort.XHIGH);
  });

  it('does not cap non-GPT-5 models even on free tier with server-side keys', () => {
    stubServerSideKeys(FREE_TIER);
    const handler = new ModelHandlerOpenRouterNative(
      buildGpt5Config({
        name: 'claude-sonnet-4-6',
        shortName: 'claude-sonnet-4-6',
      }),
    );
    assert.equal(effectiveReasoningEffort(handler), ReasoningEffort.XHIGH);
  });
});
