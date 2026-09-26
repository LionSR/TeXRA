import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import {
  routeCompatibilityKey,
  type BindableRoute,
} from '@agent/runtime/modelRoutes';
import { decideModelRoute, OWN_KEY_ROUTE_FACTS } from '@model/modelRoute';
import { isKimiCodeExclusiveModel } from '@shared/model/kimiCodeRetryGate';

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
