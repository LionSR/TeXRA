import { describe, expect, it } from 'vitest';

import { shouldRouteModelThroughOpenRouter } from '@model/openRouterRouting';

describe('shouldRouteModelThroughOpenRouter', () => {
  it.each([
    {
      name: 'routes OpenRouter-only models through OpenRouter',
      config: { openRouterOnly: true, requiresResponsesAPI: false },
      useOpenRouter: false,
      expected: true,
    },
    {
      name: 'routes ordinary models through OpenRouter when the global mode is enabled',
      config: { openRouterOnly: false, requiresResponsesAPI: false },
      useOpenRouter: true,
      expected: true,
    },
    {
      name: 'does not route Responses API models through OpenRouter',
      config: { openRouterOnly: true, requiresResponsesAPI: true },
      useOpenRouter: true,
      expected: false,
    },
  ])('$name', ({ config, useOpenRouter, expected }) => {
    expect(shouldRouteModelThroughOpenRouter(config, useOpenRouter)).toBe(
      expected,
    );
  });
});
