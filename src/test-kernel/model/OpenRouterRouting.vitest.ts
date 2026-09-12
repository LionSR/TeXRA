import { Cause, Effect, Exit } from 'effect';
import { MODEL_CONFIGS } from 'llm-zoo';
import { beforeEach, describe, expect, it } from 'vitest';

import { bindModel } from '@agent/runtime/run/modelBinding';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import {
  isOpenRouterRoutingUnsupported,
  shouldRouteModelThroughOpenRouter,
} from '@model/openRouterRouting';
import { AgentCategory } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { hostStores, setupPlatform } from '@test/support/setupPlatform';

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

  it('does not silently change access routes for a Responses API model', () => {
    expect(
      isOpenRouterRoutingUnsupported(
        { ...modeSelectedConfig, requiresResponsesAPI: true },
        true,
      ),
    ).toBe(true);
  });
});

describe('bindModel', () => {
  setupPlatform({
    globalState: {
      [GlobalStateKey.USE_OPENROUTER]: true,
      [GlobalStateKey.PREFER_SHORT_MODEL_NAMES]: true,
    },
    secrets: { [apiKeySecretName('openai')]: 'openai-key' },
  });

  beforeEach(() => {
    invalidateApiKeyCache();
  });

  const bind = (config: (typeof MODEL_CONFIGS)[string]) =>
    Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          bindModel({
            config,
            stores: hostStores(),
            compatibilityKey: null,
            agentCategory: AgentCategory.Workflow,
            temperature: 0,
            inScope: (operation) => operation(),
          }),
        ),
      ),
    );

  it('rejects a reasoning-mode model the live OpenRouter choice would discard', async () => {
    // The route the picker already reports as unavailable: a saved agent or a
    // CLI config must fail with the instruction, not run without the mode.
    const exit = await bind(MODEL_CONFIGS['gpt56pro']);

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const message = String(Cause.squash(exit.cause));
    expect(message).toContain('requires reasoning mode pro');
    expect(message).toContain('Disable OpenRouter');
  });

  it('sends the short model name when the preference is on', async () => {
    await hostStores().globalState.update(GlobalStateKey.USE_OPENROUTER, false);

    const exit = await bind(MODEL_CONFIGS['gpt4o']);

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(MODEL_CONFIGS['gpt4o'].fullName).not.toBe(
      MODEL_CONFIGS['gpt4o'].shortName,
    );
    expect(exit.value.origin.requestedModel).toBe(
      MODEL_CONFIGS['gpt4o'].shortName,
    );
  });
});
