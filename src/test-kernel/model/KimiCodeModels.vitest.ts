import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import {
  routeCompatibilityKey,
  type BindableRoute,
} from '@agent/runtime/modelRoutes';
import { decideModelRoute, OWN_KEY_ROUTE_FACTS } from '@model/modelRoute';
import {
  isKimiCodeExclusiveModel,
  isKimiCodeExclusiveRetryModel,
  isKimiCodeSubscriptionRetryBlocked,
} from '@shared/model/kimiCodeRetryGate';

describe('Kimi Code exclusivity single-source', () => {
  it('keeps the retry model-id gate aligned with the shared field predicate', () => {
    for (const [id, config] of Object.entries(MODEL_CONFIGS)) {
      expect(isKimiCodeExclusiveRetryModel(id)).toBe(
        isKimiCodeExclusiveModel(config),
      );
    }
    expect(isKimiCodeExclusiveRetryModel(undefined)).toBe(false);
    expect(isKimiCodeExclusiveRetryModel('not-a-registered-model')).toBe(false);
  });

  it('blocks the personal-key switch only for exclusive plan-quota exhaustion', () => {
    expect(
      isKimiCodeSubscriptionRetryBlocked(
        'kimiCoding',
        'kimi-code-subscription',
      ),
    ).toBe(true);
    expect(
      isKimiCodeSubscriptionRetryBlocked('kimiCoding', 'upstream-credit'),
    ).toBe(false);
    expect(
      isKimiCodeSubscriptionRetryBlocked('kimi3', 'kimi-code-subscription'),
    ).toBe(false);
    expect(
      isKimiCodeSubscriptionRetryBlocked(undefined, 'kimi-code-subscription'),
    ).toBe(false);
  });
});

describe('Kimi Code routing', () => {
  const route = (model: string, useOpenRouter: boolean) =>
    decideModelRoute(MODEL_CONFIGS[model], {
      ...OWN_KEY_ROUTE_FACTS,
      useOpenRouter,
    }) as BindableRoute;

  it('keeps the direct Kimi Code route when OpenRouter is globally enabled', () => {
    expect(route('kimiCoding', true)).toEqual({
      kind: 'api-key',
      provider: 'kimiCode',
      usageRoute: 'kimi-code-subscription',
    });
  });

  it.effect(
    'uses the shared Kimi handler, and OpenRouter for kimi3 when on',
    () =>
      Effect.gen(function* () {
        expect(
          yield* routeCompatibilityKey(
            MODEL_CONFIGS.kimiCoding,
            route('kimiCoding', false),
          ),
        ).toBe('Kimi');
        expect(
          yield* routeCompatibilityKey(
            MODEL_CONFIGS.kimi3,
            route('kimi3', false),
          ),
        ).toBe('Kimi');
        expect(
          yield* routeCompatibilityKey(
            MODEL_CONFIGS.kimi3,
            route('kimi3', true),
          ),
        ).toBe('OpenRouterNative');
      }),
  );

  it('does not divert other moonshot models off their normal routes', () => {
    expect(route('kimi25T', false)).toEqual({
      kind: 'api-key',
      provider: 'moonshot',
      usageRoute: 'api-key',
    });
  });
});
