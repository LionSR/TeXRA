import { describe, expect, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

import {
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
  kimiCodeRuntimeConfig,
  kimiCodeWireModelId,
  resolveKimiCodeRoute,
} from '@model/kimiCodeSubscriptionRouting';
import { KIMI_CODE_BASE_URL } from '@shared/constants/providers';
import type { ModelConfig } from 'llm-zoo';

const dual = {
  provider: ModelProvider.MOONSHOT,
  kimiSubscription: true,
  fullName: 'kimi-k3',
} as const;

const exclusive = {
  provider: ModelProvider.MOONSHOT,
  kimiSubscription: true,
  baseUrl: KIMI_CODE_BASE_URL,
  fullName: 'kimi-for-coding',
} as const;

describe('isKimiSubscriptionEligible', () => {
  it('is true only for kimiSubscription-flagged Moonshot models', () => {
    expect(isKimiSubscriptionEligible(dual)).toBe(true);
    expect(isKimiSubscriptionEligible(exclusive)).toBe(true);
    expect(
      isKimiSubscriptionEligible({
        provider: ModelProvider.OPENAI,
        kimiSubscription: true,
      }),
    ).toBe(false);
    expect(
      isKimiSubscriptionEligible({ provider: ModelProvider.MOONSHOT }),
    ).toBe(false);
  });
});

describe('isKimiCodeExclusiveModel', () => {
  it('requires the pinned coding base URL', () => {
    expect(isKimiCodeExclusiveModel(exclusive)).toBe(true);
    expect(isKimiCodeExclusiveModel(dual)).toBe(false);
  });
});

describe('kimiCodeWireModelId', () => {
  it('rewrites kimi-k3 to k3 and passes plan aliases through', () => {
    expect(kimiCodeWireModelId({ fullName: 'kimi-k3' })).toBe('k3');
    expect(kimiCodeWireModelId({ fullName: 'kimi-for-coding' })).toBe(
      'kimi-for-coding',
    );
  });
});

describe('resolveKimiCodeRoute', () => {
  it('never routes an ineligible model', () => {
    expect(
      resolveKimiCodeRoute(
        { provider: ModelProvider.MOONSHOT },
        false,
        true,
        true,
        false,
      ),
    ).toBeNull();
  });

  it('routes exclusive models whenever a key is set, ignoring the toggles', () => {
    // key + prefer off + openRouter on + included on: still routes (no other
    // backend exists for coding-only models, and they never allow the relay).
    expect(resolveKimiCodeRoute(exclusive, true, true, false, true)).toBe(
      'kimiCode',
    );
    // no key: cannot route.
    expect(
      resolveKimiCodeRoute(exclusive, false, false, true, false),
    ).toBeNull();
  });

  it('routes dual-backend only with prefer on, a key set, and OpenRouter off', () => {
    expect(resolveKimiCodeRoute(dual, false, true, true, false)).toBe(
      'kimiCode',
    );
    // prefer off → open platform.
    expect(resolveKimiCodeRoute(dual, false, true, false, false)).toBeNull();
    // no key → open platform.
    expect(resolveKimiCodeRoute(dual, false, false, true, false)).toBeNull();
    // OpenRouter on → open-router path wins.
    expect(resolveKimiCodeRoute(dual, true, true, true, false)).toBeNull();
  });

  it('leaves dual-backend models to the relay under included access', () => {
    // Included (relay) access owns eligible models: the rerouted config's
    // pinned coding baseUrl would outrank the relay URL while the credential
    // layer resolves a relay token, so the reroute must not happen.
    expect(resolveKimiCodeRoute(dual, false, true, true, true)).toBeNull();
  });
});

describe('kimiCodeRuntimeConfig', () => {
  it('pins the coding base URL and swaps in the coding wire id', () => {
    const config = {
      provider: ModelProvider.MOONSHOT,
      kimiSubscription: true,
      fullName: 'kimi-k3',
      shortName: 'kimi-k3',
      contextWindow: 262_144,
    } as unknown as ModelConfig;
    const runtime = kimiCodeRuntimeConfig(config);
    expect(runtime.fullName).toBe('k3');
    expect(runtime.shortName).toBe('k3');
    expect(runtime.baseUrl).toBe(KIMI_CODE_BASE_URL);
    // The synthesized config now reads as exclusive, so downstream registry-
    // fact predicates route it to the kimiCode credential + coding endpoint.
    expect(isKimiCodeExclusiveModel(runtime)).toBe(true);
  });
});
