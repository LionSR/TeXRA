// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { MODEL_CONFIGS } from 'llm-zoo';
import { describe, it, vi } from 'vitest';

// Local imports - shared provider registry
import { SERVER_SIDE_PROVIDER_IDS } from '@shared/constants/providers';

// A retired model whose provider is not in RELAY_PROVIDERS (e.g. 'meta') is
// not currently present in the pinned llm-zoo registry, so this synthetic
// entry pins down the RETIRED_MODEL_PATTERNS derivation directly: it must
// keep covering every retired, non-openRouterOnly model regardless of
// forwarding-provider eligibility (see #7947, #7953).
vi.mock('llm-zoo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('llm-zoo')>();
  return {
    ...actual,
    MODEL_CONFIGS: {
      ...actual.MODEL_CONFIGS,
      retiredOutsideRelayProviders: {
        name: 'legacy-meta-model',
        fullName: 'legacy-meta-model',
        provider: 'meta',
        retired: true,
        openRouterOnly: false,
      },
    },
  };
});

// Local imports - Supabase relay
import {
  FREE_TIER,
  MAX_TIER,
  TIER_CONFIG,
  ULTRA_ONLY_PROVIDER_SET,
  ULTRA_TIER,
  isModelAllowedForTier,
  isRetiredModelRequest,
} from '../../../supabase/functions/relay/models';

describe('relay tier model access', () => {
  it('keeps client server-key providers aligned with relay routing', () => {
    assert.deepEqual(
      SERVER_SIDE_PROVIDER_IDS.toSorted(),
      TIER_CONFIG.providers.toSorted(),
    );
  });

  it('limits Max to non-Ultra providers and keeps Ultra passthrough', () => {
    const maxModels = TIER_CONFIG.tiers.Max?.models;
    assert.ok(Array.isArray(maxModels));
    assert.deepEqual(
      maxModels,
      Object.values(MODEL_CONFIGS)
        .filter(
          (model) =>
            TIER_CONFIG.providers.includes(model.provider) &&
            !model.openRouterOnly &&
            !model.retired &&
            !ULTRA_ONLY_PROVIDER_SET.has(model.provider.toLowerCase()) &&
            // Kimi Code membership models are pinned to the coding endpoint and
            // are not relay-servable (see RELAY_MODELS in models.ts).
            (model as { baseUrl?: string }).baseUrl !==
              'https://api.kimi.com/coding/v1',
        )
        .map((model) => model.name),
    );
    assert.equal(TIER_CONFIG.tiers.Ultra?.models, '*');

    assert.equal(isModelAllowedForTier(MAX_TIER, 'unknown-model'), true);
    assert.equal(isModelAllowedForTier(MAX_TIER, null), false);
    assert.equal(isModelAllowedForTier(ULTRA_TIER, 'unknown-model'), true);
    assert.equal(isModelAllowedForTier(ULTRA_TIER, null), true);
  });

  it('keeps free tier restricted to known price-bounded models', () => {
    assert.equal(isModelAllowedForTier(FREE_TIER, 'gemini-3.5-flash'), true);
    assert.equal(
      isModelAllowedForTier(FREE_TIER, 'google/gemini-3.5-flash'),
      true,
    );
    assert.equal(isModelAllowedForTier(FREE_TIER, 'gpt-5-2025-08-07'), false);
    assert.equal(isModelAllowedForTier(FREE_TIER, 'muse-spark-1.1'), false);
    assert.equal(isModelAllowedForTier(FREE_TIER, 'unknown-model'), false);
    assert.equal(isModelAllowedForTier(FREE_TIER, null), false);
  });

  it('denies retired registry models for relay passthrough tiers', () => {
    assert.equal(isRetiredModelRequest('haiku3'), true);
    assert.equal(
      isRetiredModelRequest('anthropic/claude-3.5-haiku-20240307:beta'),
      true,
    );
    assert.equal(isRetiredModelRequest('unknown-model'), false);

    assert.equal(
      isModelAllowedForTier(MAX_TIER, 'claude-3-haiku-20240307'),
      false,
    );
    assert.equal(
      isModelAllowedForTier(ULTRA_TIER, 'anthropic/claude-3-haiku-20240307'),
      false,
    );
    assert.equal(isModelAllowedForTier(ULTRA_TIER, 'unknown-model'), true);
  });

  it('denies retired models from providers outside RELAY_PROVIDERS', () => {
    // Regression coverage for #7953: RETIRED_MODEL_PATTERNS must not be
    // filtered by RELAY_PROVIDERS.has(m.provider) — a retired model from a
    // provider the relay cannot forward to (here 'meta') must still be
    // rejected as a denial guard, independent of forwarding eligibility.
    // Assert the fixture premise against the same source RELAY_PROVIDERS is
    // built from, so this test fails loudly (instead of going vacuous) if
    // 'meta' is ever added to the relay allowlist.
    assert.equal(TIER_CONFIG.providers.includes('meta'), false);
    assert.equal(isRetiredModelRequest('legacy-meta-model'), true);
    assert.equal(isModelAllowedForTier(MAX_TIER, 'legacy-meta-model'), false);
    assert.equal(isModelAllowedForTier(ULTRA_TIER, 'legacy-meta-model'), false);
  });
});
