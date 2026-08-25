import { describe, expect, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

import {
  isKimiCodeRoute,
  kimiCodeEffectiveConfig,
} from '@model/kimiCodeSubscriptionRouting';
import { KIMI_CODE_BASE_URL } from '@shared/constants/providers';
import {
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
} from '@shared/model/kimiCodeRetryGate';
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

const facts = (
  useOpenRouter: boolean,
  keySet: boolean,
  preferKimiCode: boolean,
) => ({ useOpenRouter, keySet, preferKimiCode });

describe('isKimiCodeRoute', () => {
  it('never routes an ineligible model', () => {
    expect(
      isKimiCodeRoute(
        { provider: ModelProvider.MOONSHOT },
        facts(false, true, true),
      ),
    ).toBe(false);
  });

  it('routes exclusive models whenever a key is set, ignoring the toggles', () => {
    // key + prefer off + openRouter on: still routes (no other backend exists
    // for coding-only models).
    expect(isKimiCodeRoute(exclusive, facts(true, true, false))).toBe(true);
    // no key: cannot route.
    expect(isKimiCodeRoute(exclusive, facts(false, false, true))).toBe(false);
  });

  it('routes dual-backend only with prefer on, a key set, and OpenRouter off', () => {
    expect(isKimiCodeRoute(dual, facts(false, true, true))).toBe(true);
    // prefer off → open platform.
    expect(isKimiCodeRoute(dual, facts(false, true, false))).toBe(false);
    // no key → open platform.
    expect(isKimiCodeRoute(dual, facts(false, false, true))).toBe(false);
    // OpenRouter on → open-router path wins.
    expect(isKimiCodeRoute(dual, facts(true, true, true))).toBe(false);
  });
});

describe('kimiCodeEffectiveConfig', () => {
  it('pins the coding base URL and swaps in the coding wire id', () => {
    const config = {
      provider: ModelProvider.MOONSHOT,
      kimiSubscription: true,
      fullName: 'kimi-k3',
      shortName: 'kimi-k3',
      contextWindow: 262_144,
    } as unknown as ModelConfig;
    const runtime = kimiCodeEffectiveConfig(config, facts(false, true, true));
    expect(runtime.fullName).toBe('k3');
    expect(runtime.shortName).toBe('k3');
    expect(runtime.baseUrl).toBe(KIMI_CODE_BASE_URL);
    // The synthesized config now reads as exclusive, so downstream registry-
    // fact predicates route it to the kimiCode credential + coding endpoint.
    expect(isKimiCodeExclusiveModel(runtime)).toBe(true);
  });
});
