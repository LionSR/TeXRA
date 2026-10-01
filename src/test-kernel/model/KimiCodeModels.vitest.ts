import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';
import { MODEL_CONFIGS, type ModelRef } from 'llm-zoo';

import {
  routeCompatibilityKey,
  type BindableRoute,
} from '@agent/runtime/modelRoutes';
import { decideModelRoute, OWN_KEY_ROUTE_FACTS } from '@model/modelRoute';

const KIMI_CODING = 'moonshot/kimi-for-coding';
const KIMI3 = 'moonshot/kimi-k3';

describe('Kimi Code routing', () => {
  const route = (model: ModelRef, useOpenRouter: boolean) =>
    decideModelRoute(MODEL_CONFIGS[model], {
      ...OWN_KEY_ROUTE_FACTS,
      useOpenRouter,
    }) as BindableRoute;

  it('keeps the direct Kimi Code route when OpenRouter is globally enabled', () => {
    expect(route(KIMI_CODING, true)).toEqual({
      kind: 'api-key',
      provider: 'kimiCode',
      usageRoute: 'kimi-code-subscription',
    });
  });

  it.effect(
    'uses the shared Kimi handler, and OpenRouter for Kimi K3 when on',
    () =>
      Effect.gen(function* () {
        expect(
          yield* routeCompatibilityKey(
            MODEL_CONFIGS[KIMI_CODING],
            route(KIMI_CODING, false),
          ),
        ).toBe('Kimi');
        expect(
          yield* routeCompatibilityKey(
            MODEL_CONFIGS[KIMI3],
            route(KIMI3, false),
          ),
        ).toBe('Kimi');
        expect(
          yield* routeCompatibilityKey(
            MODEL_CONFIGS[KIMI3],
            route(KIMI3, true),
          ),
        ).toBe('OpenRouterNative');
      }),
  );

  it('does not divert other moonshot models off their normal routes', () => {
    expect(route(KIMI3, false)).toEqual({
      kind: 'api-key',
      provider: 'moonshot',
      usageRoute: 'api-key',
    });
  });
});
