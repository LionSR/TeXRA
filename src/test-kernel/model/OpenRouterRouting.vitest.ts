import { describe, expect, it } from 'vitest';

import {
  isOpenRouterRoutingUnsupported,
  shouldRouteModelThroughOpenRouter,
} from '@model/openRouterRouting';

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
    {
      name: 'does not override a managed direct route',
      config: {
        openRouterOnly: false,
        provider: 'moonshot',
        kimiSubscription: true,
        baseUrl: 'https://api.kimi.com/coding/v1',
      },
      useOpenRouter: true,
      expected: false,
    },
  ])('$name', ({ config, useOpenRouter, expected }) => {
    expect(shouldRouteModelThroughOpenRouter(config, useOpenRouter)).toBe(
      expected,
    );
  });
});

describe('isOpenRouterRoutingUnsupported', () => {
  const modeSelectedConfig = {
    openRouterOnly: false,
    requiresResponsesAPI: false,
    capabilities: { reasoningMode: 'pro' as const },
  };

  it('rejects a route that would discard a selected reasoning mode', () => {
    expect(isOpenRouterRoutingUnsupported(modeSelectedConfig, true)).toBe(true);
  });

  it('allows an explicitly direct model to preserve its mode', () => {
    expect(
      isOpenRouterRoutingUnsupported(
        { ...modeSelectedConfig, forceDirectProvider: true },
        true,
      ),
    ).toBe(false);
  });

  it('does not silently change access routes for a Responses API model', () => {
    expect(
      isOpenRouterRoutingUnsupported(
        { ...modeSelectedConfig, requiresResponsesAPI: true },
        true,
      ),
    ).toBe(true);
  });
});
