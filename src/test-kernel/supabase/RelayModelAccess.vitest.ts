import { strict as assert } from 'node:assert';

import { MODEL_CONFIGS } from 'llm-zoo';
import { describe, it, vi } from 'vitest';

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

import {
  FREE_TIER,
  FREE_TIER_SUGGESTED_MODEL,
  MAX_TIER,
  PROVIDER_CONFIGS,
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
    assert.equal(Object.isFrozen(PROVIDER_CONFIGS), true);
    for (const config of Object.values(PROVIDER_CONFIGS)) {
      assert.equal(Object.isFrozen(config), true);
    }
  });

  it('limits Max to non-Ultra providers and keeps Ultra passthrough', () => {
    const maxModels = TIER_CONFIG.tiers.Max?.models;
    assert.ok(Array.isArray(maxModels));
    assert.ok(maxModels.length > 0);

    // Assert the contract on each advertised member with independent
    // per-property checks instead of re-deriving the list with a mirrored
    // filter chain: a predicate mistake copied into both sides of the
    // assertion would pass silently, while these checks fail if production
    // drops any one of its filters (see RELAY_MODELS in models.ts).
    const configsByName = new Map<string, (typeof MODEL_CONFIGS)[string][]>();
    for (const config of Object.values(MODEL_CONFIGS)) {
      const list = configsByName.get(config.name) ?? [];
      list.push(config);
      configsByName.set(config.name, list);
    }
    for (const name of maxModels) {
      const candidates = configsByName.get(name) ?? [];
      assert.ok(
        candidates.length > 0,
        `Max-advertised model '${name}' must exist in llm-zoo`,
      );
      // Model names are unique among relay-servable entries (the only
      // duplicate name in the pinned registry is an Ultra-only Google
      // model), so every entry behind an advertised name must qualify.
      for (const model of candidates) {
        assert.equal(model.retired ?? false, false, `'${name}' is retired`);
        assert.equal(
          model.openRouterOnly ?? false,
          false,
          `'${name}' is openRouterOnly`,
        );
        assert.equal(
          TIER_CONFIG.providers.includes(model.provider),
          true,
          `'${name}' provider '${model.provider}' is not relay-routable`,
        );
        assert.equal(
          ULTRA_ONLY_PROVIDER_SET.has(model.provider.toLowerCase()),
          false,
          `'${name}' belongs to an Ultra-only provider`,
        );
        // Kimi Code membership models are pinned to the coding endpoint and
        // are not relay-servable.
        assert.notEqual(
          (model as { baseUrl?: string }).baseUrl,
          'https://api.kimi.com/coding/v1',
          `'${name}' is pinned to the Kimi coding endpoint`,
        );
      }
      // The advertised list and the request gate must agree.
      assert.equal(isModelAllowedForTier(MAX_TIER, name), true);
    }
    // The free-tier suggestion is what over-tier 403 denials point users at,
    // so it must stay reachable on Max.
    assert.ok(maxModels.includes(FREE_TIER_SUGGESTED_MODEL));

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
