import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';
import { MODEL_CONFIGS, type ModelRef } from 'llm-zoo';

import { decideModelRoute, OWN_KEY_ROUTE_FACTS } from '@texra-ai/llm';
import { routeBackend, type BindableRoute } from '@agent/runtime/modelRoutes';

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
          yield* routeBackend(
            MODEL_CONFIGS[KIMI_CODING],
            route(KIMI_CODING, false),
          ),
        ).toBe('moonshot');
        expect(
          yield* routeBackend(MODEL_CONFIGS[KIMI3], route(KIMI3, false)),
        ).toBe('moonshot');
        expect(
          yield* routeBackend(MODEL_CONFIGS[KIMI3], route(KIMI3, true)),
        ).toBe('openRouter');
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
