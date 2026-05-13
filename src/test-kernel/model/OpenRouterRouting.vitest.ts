import { describe, expect, it } from 'vitest';

import { shouldRouteModelThroughOpenRouter } from '@model/openRouterRouting';

describe('shouldRouteModelThroughOpenRouter', () => {
  it('routes OpenRouter-only models through OpenRouter', () => {
    expect(
      shouldRouteModelThroughOpenRouter(
        { openRouterOnly: true, requiresResponsesAPI: false },
        false,
      ),
    ).toBe(true);
  });

  it('routes ordinary models through OpenRouter when the global mode is enabled', () => {
    expect(
      shouldRouteModelThroughOpenRouter(
        { openRouterOnly: false, requiresResponsesAPI: false },
        true,
      ),
    ).toBe(true);
  });

  it('does not route Responses API models through OpenRouter', () => {
    expect(
      shouldRouteModelThroughOpenRouter(
        { openRouterOnly: true, requiresResponsesAPI: true },
        true,
      ),
    ).toBe(false);
  });
});
