import { describe, expect, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

import {
  decideModelRoute,
  OWN_KEY_ROUTE_FACTS,
  routeConfig,
} from '@texra-ai/llm';
import { KIMI_CODE_BASE_URL } from '../../../packages/llm/src/providers/providers.js';
import type { ModelConfig } from 'llm-zoo';

const dual = {
  provider: ModelProvider.MOONSHOT,
  kimiSubscription: true,
  id: 'kimi-k3',
} as const;

const exclusive = {
  provider: ModelProvider.MOONSHOT,
  kimiSubscription: true,
  baseUrl: KIMI_CODE_BASE_URL,
  id: 'kimi-for-coding',
} as const;

const asConfig = (fields: object) =>
  ({ openRouterOnly: false, capabilities: {}, ...fields }) as ModelConfig;

const kimiRoute = (
  fields: object,
  kimiCodeKey: boolean,
  preferKimiCode: boolean,
) =>
  decideModelRoute(asConfig(fields), {
    ...OWN_KEY_ROUTE_FACTS,
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
      kimiRoute({ provider: ModelProvider.MOONSHOT }, true, true),
    ).not.toEqual(onKimiCode);
  });

  it('routes exclusive models to Kimi Code whatever the toggles say', () => {
    // No other backend exists for coding-only models, so even without a key
    // the route is Kimi Code (and the picker reports the key missing).
    expect(kimiRoute(exclusive, true, false)).toEqual(onKimiCode);
    expect(kimiRoute(exclusive, false, true)).toEqual(onKimiCode);
  });

  it('routes dual-backend only with prefer on and a key set', () => {
    expect(kimiRoute(dual, true, true)).toEqual(onKimiCode);
    // prefer off → open platform.
    expect(kimiRoute(dual, true, false)).not.toEqual(onKimiCode);
    // no key → open platform.
    expect(kimiRoute(dual, false, true)).not.toEqual(onKimiCode);
  });
});

describe('routeConfig on Kimi Code', () => {
  it('swaps in the coding wire id without touching baseUrl', () => {
    const config = asConfig({
      provider: ModelProvider.MOONSHOT,
      kimiSubscription: true,
      id: 'kimi-k3',
      shortName: 'kimi-k3',
      contextWindow: 1_048_576,
    });
    const runtime = routeConfig(
      config,
      decideModelRoute(config, {
        ...OWN_KEY_ROUTE_FACTS,
        kimiCodeKey: true,
        preferKimiCode: true,
      }),
      { chatgptContextWindow: 0 },
    );
    expect(runtime.id).toBe('k3');
    expect(runtime.shortName).toBe('k3');
    expect(runtime.contextWindow).toBe(262_144);
    // The route, not a pinned baseUrl, names the coding endpoint.
    expect(runtime.baseUrl).toBeUndefined();
  });
});
