import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS, type ModelRef } from 'llm-zoo';

import { decideModelRoute, OWN_KEY_ROUTE_FACTS } from '@texra-ai/llm';

const KIMI_CODING = 'moonshot/kimi-for-coding';
const KIMI3 = 'moonshot/kimi-k3';

describe('Kimi Code routing', () => {
  const route = (model: ModelRef, useOpenRouter: boolean) =>
    decideModelRoute(MODEL_CONFIGS[model], {
      ...OWN_KEY_ROUTE_FACTS,
      useOpenRouter,
    });

  it('keeps the direct Kimi Code route when OpenRouter is globally enabled', () => {
    expect(route(KIMI_CODING, true)).toEqual({
      kind: 'api-key',
      provider: 'kimiCode',
      usageRoute: 'kimi-code-subscription',
    });
  });

  it('does not divert other moonshot models off their normal routes', () => {
    expect(route(KIMI3, false)).toEqual({
      kind: 'api-key',
      provider: 'moonshot',
      usageRoute: 'api-key',
    });
  });
});
