// Third-party imports
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { resolveProxyEndpoint } from '@agent/modelHandlers/support/ProxyConfigResolver';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import { resolveGlmRoute } from '@model/glmRouting';
import {
  activeSubscriptionUsageRoute,
  codingPlanSubscriptionRuntimes,
} from '@model/codingPlanSubscriptions';
import { platform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { setupPlatform } from '@test/support/setupPlatform';

describe('coding-plan subscription runtime', () => {
  setupPlatform({
    globalState: {
      [GlobalStateKey.GLM_CODING_PLAN]: true,
      [GlobalStateKey.KIMI_CODE_PREFER]: false,
      [GlobalStateKey.USE_OPENROUTER]: true,
    },
    secrets: { [apiKeySecretName('glm')]: 'glm-key' },
  });

  beforeEach(() => {
    invalidateApiKeyCache();
  });

  afterEach(async () => {
    delete MODEL_CONFIGS.glm52.baseUrl;
    await platform().globalState.update(GlobalStateKey.ENDPOINT_GLM, '');
    await platform().globalState.update(GlobalStateKey.GLM_CODING_PLAN, true);
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, true);
  });

  it('freezes every runtime catalog entry', () => {
    expect(Object.isFrozen(codingPlanSubscriptionRuntimes)).toBe(true);
    expect(codingPlanSubscriptionRuntimes.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    {
      name: 'Coding Plan',
      useOpenRouter: false,
      providerEndpoint: '',
      modelBaseUrl: undefined,
      route: 'official-coding-plan',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      usageRoute: 'glm-coding-plan-subscription',
    },
    {
      name: 'provider custom endpoint',
      useOpenRouter: false,
      providerEndpoint: 'http://proxy.test/api/coding/paas/v4/',
      modelBaseUrl: undefined,
      route: 'provider-custom',
      baseUrl: 'https://proxy.test/api/coding/paas/v4',
      usageRoute: undefined,
    },
    {
      name: 'model custom endpoint',
      useOpenRouter: true,
      providerEndpoint: 'provider.test/v4',
      modelBaseUrl: 'https://model.test/v4',
      route: 'model-custom',
      baseUrl: 'https://model.test/v4',
      usageRoute: undefined,
    },
    {
      name: 'OpenRouter',
      useOpenRouter: true,
      providerEndpoint: 'provider.test/v4',
      modelBaseUrl: undefined,
      route: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      usageRoute: undefined,
    },
  ])(
    'keeps the canonical route, proxy endpoint, and subscription usage aligned for $name',
    async ({
      useOpenRouter,
      providerEndpoint,
      modelBaseUrl,
      route,
      baseUrl,
      usageRoute,
    }) => {
      await platform().globalState.update(
        GlobalStateKey.USE_OPENROUTER,
        useOpenRouter,
      );
      await platform().globalState.update(
        GlobalStateKey.ENDPOINT_GLM,
        providerEndpoint,
      );
      if (modelBaseUrl) MODEL_CONFIGS.glm52.baseUrl = modelBaseUrl;

      const canonical = resolveGlmRoute({
        baseUrl: modelBaseUrl,
        useOpenRouter,
      });
      const proxy = resolveProxyEndpoint(
        modelBaseUrl
          ? {
              route: 'custom',
              provider: ModelProvider.GLM,
              url: modelBaseUrl,
            }
          : {
              route: 'direct',
              provider: ModelProvider.GLM,
              useOpenRouter,
            },
      );

      expect(canonical).toMatchObject({ route, baseUrl });
      expect(proxy).toMatchObject({ baseUrl });
      expect('usageRoute' in proxy ? proxy.usageRoute : undefined).toBe(
        usageRoute,
      );
      await expect(activeSubscriptionUsageRoute('glm52')).resolves.toBe(
        usageRoute,
      );
    },
  );

  it('restores Kimi preference without overwriting newer OpenRouter state', async () => {
    const kimi = codingPlanSubscriptionRuntimes.find(
      (runtime) => runtime.descriptor.id === 'kimiCode',
    );

    await kimi?.restoreEnabled(true);

    expect(
      platform().globalState.get(GlobalStateKey.KIMI_CODE_PREFER, false),
    ).toBe(true);
    expect(
      platform().globalState.get(GlobalStateKey.USE_OPENROUTER, false),
    ).toBe(true);
  });
});
