import { it as effectIt } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

import {
  decideModelRoute,
  OWN_KEY_ROUTE_FACTS,
  routeConfig,
} from '@model/modelRoute';
import type { SettingsStores } from '@shared/config/settingsAccess';
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

const asConfig = (fields: object) =>
  ({ openRouterOnly: false, capabilities: {}, ...fields }) as ModelConfig;

const kimiRoute = (
  fields: object,
  useOpenRouter: boolean,
  kimiCodeKey: boolean,
  preferKimiCode: boolean,
) =>
  decideModelRoute(asConfig(fields), {
    ...OWN_KEY_ROUTE_FACTS,
    useOpenRouter,
    kimiCodeKey,
    preferKimiCode,
  });

const onKimiCode = {
  kind: 'api-key',
  provider: 'kimiCode',
  usageRoute: 'kimi-code-subscription',
};

describe('decideModelRoute on Kimi Code', () => {
  it('never routes an ineligible model', () => {
    expect(
      kimiRoute({ provider: ModelProvider.MOONSHOT }, false, true, true),
    ).not.toEqual(onKimiCode);
  });

  it('routes exclusive models to Kimi Code whatever the toggles say', () => {
    // No other backend exists for coding-only models, so even without a key
    // the route is Kimi Code (and the picker reports the key missing).
    expect(kimiRoute(exclusive, true, true, false)).toEqual(onKimiCode);
    expect(kimiRoute(exclusive, false, false, true)).toEqual(onKimiCode);
  });

  it('routes dual-backend only with prefer on, a key set, and OpenRouter off', () => {
    expect(kimiRoute(dual, false, true, true)).toEqual(onKimiCode);
    // prefer off → open platform.
    expect(kimiRoute(dual, false, true, false)).not.toEqual(onKimiCode);
    // no key → open platform.
    expect(kimiRoute(dual, false, false, true)).not.toEqual(onKimiCode);
    // OpenRouter on → the OpenRouter path wins.
    expect(kimiRoute(dual, true, true, true)).toEqual({ kind: 'openrouter' });
  });
});

describe('routeConfig on Kimi Code', () => {
  effectIt.effect('swaps in the coding wire id without touching baseUrl', () =>
    Effect.gen(function* () {
      const config = asConfig({
        provider: ModelProvider.MOONSHOT,
        kimiSubscription: true,
        fullName: 'kimi-k3',
        shortName: 'kimi-k3',
        contextWindow: 1_048_576,
      });
      const runtime = yield* routeConfig(
        {} as SettingsStores,
        config,
        decideModelRoute(config, {
          ...OWN_KEY_ROUTE_FACTS,
          kimiCodeKey: true,
          preferKimiCode: true,
        }),
      );
      expect(runtime.fullName).toBe('k3');
      expect(runtime.shortName).toBe('k3');
      expect(runtime.contextWindow).toBe(262_144);
      // The route, not a pinned baseUrl, names the coding endpoint.
      expect(runtime.baseUrl).toBeUndefined();
    }),
  );
});
