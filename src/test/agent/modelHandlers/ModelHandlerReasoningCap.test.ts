// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from 'llm-zoo';

// Local imports - handler under test (concrete subclass exercising base-class
// `getEffectiveReasoningEffort` — OpenRouterNative does not override it)
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/modelHandlerOpenRouterNative';
import { FREE_TIER, MAX_TIER, ULTRA_TIER } from '@auth/config';

// Modules to monkey-patch
import * as serverKeysModule from '@auth/serverKeys';
import * as providerConfigModule from '@utils/config/providerConfig';

function buildGpt5Config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
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
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsReasoningEffort: true,
      reasoningEffort: ReasoningEffort.XHIGH,
    },
    openRouterOnly: false,
    openrouterFullName: 'openai/gpt-5-mini',
    ...overrides,
  };
}

describe('ModelHandler.getEffectiveReasoningEffort tier caps', () => {
  const originalGetUseOpenRouter = providerConfigModule.getUseOpenRouter;
  const originalGetServerSideKeyService =
    serverKeysModule.getServerSideKeyService;

  function stubServerSideKeys(tier: string | null): void {
    (
      providerConfigModule as {
        getUseOpenRouter: typeof originalGetUseOpenRouter;
      }
    ).getUseOpenRouter = () => false;

    (
      serverKeysModule as {
        getServerSideKeyService: typeof originalGetServerSideKeyService;
      }
    ).getServerSideKeyService = () =>
      ({
        shouldUseServerSideKeysSync: () => true,
        getUserTier: () => tier,
        getUseIncludedModelAccess: () => true,
        canUseServerSideKeys: async () => true,
        getRelayBaseUrl: (provider: string) =>
          `https://relay.example.com/functions/v1/relay/${provider}/v1`,
      }) as unknown as ReturnType<typeof originalGetServerSideKeyService>;
  }

  afterEach(() => {
    (
      providerConfigModule as {
        getUseOpenRouter: typeof originalGetUseOpenRouter;
      }
    ).getUseOpenRouter = originalGetUseOpenRouter;
    (
      serverKeysModule as {
        getServerSideKeyService: typeof originalGetServerSideKeyService;
      }
    ).getServerSideKeyService = originalGetServerSideKeyService;
  });

  it('caps xhigh to medium for free tier on GPT-5 with server-side keys', () => {
    stubServerSideKeys(FREE_TIER);
    const handler = new ModelHandlerOpenRouterNative(buildGpt5Config());
    assert.equal(
      (handler as any).getEffectiveReasoningEffort(),
      ReasoningEffort.MEDIUM,
    );
  });

  it('caps xhigh to high for Max tier on GPT-5 with server-side keys', () => {
    stubServerSideKeys(MAX_TIER);
    const handler = new ModelHandlerOpenRouterNative(buildGpt5Config());
    assert.equal(
      (handler as any).getEffectiveReasoningEffort(),
      ReasoningEffort.HIGH,
    );
  });

  it('does not cap xhigh for Ultra tier on GPT-5 with server-side keys', () => {
    stubServerSideKeys(ULTRA_TIER);
    const handler = new ModelHandlerOpenRouterNative(buildGpt5Config());
    assert.equal(
      (handler as any).getEffectiveReasoningEffort(),
      ReasoningEffort.XHIGH,
    );
  });

  it('does not cap when not using server-side keys (free tier, own key)', () => {
    (
      providerConfigModule as {
        getUseOpenRouter: typeof originalGetUseOpenRouter;
      }
    ).getUseOpenRouter = () => false;

    (
      serverKeysModule as {
        getServerSideKeyService: typeof originalGetServerSideKeyService;
      }
    ).getServerSideKeyService = () =>
      ({
        shouldUseServerSideKeysSync: () => false,
        getUserTier: () => FREE_TIER,
        getUseIncludedModelAccess: () => false,
        canUseServerSideKeys: async () => false,
        getRelayBaseUrl: (provider: string) =>
          `https://relay.example.com/functions/v1/relay/${provider}/v1`,
      }) as unknown as ReturnType<typeof originalGetServerSideKeyService>;

    const handler = new ModelHandlerOpenRouterNative(buildGpt5Config());
    assert.equal(
      (handler as any).getEffectiveReasoningEffort(),
      ReasoningEffort.XHIGH,
    );
  });

  it('does not cap non-GPT-5 models even on free tier with server-side keys', () => {
    stubServerSideKeys(FREE_TIER);
    const handler = new ModelHandlerOpenRouterNative(
      buildGpt5Config({
        name: 'claude-sonnet-4-6',
        shortName: 'claude-sonnet-4-6',
      }),
    );
    assert.equal(
      (handler as any).getEffectiveReasoningEffort(),
      ReasoningEffort.XHIGH,
    );
  });
});
