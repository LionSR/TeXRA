// Third-party imports
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { resolveRouteEndpoint } from '@agent/runtime/run/routeEndpoint';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import { resolveGlmRoute } from '@model/glmRouting';
import {
  activeSubscriptionUsageRoute,
  codingPlanSubscriptionRuntimes,
} from '@model/codingPlanSubscriptions';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { hostStores, setupPlatform } from '@test/support/setupPlatform';

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
    await hostStores().globalState.update(GlobalStateKey.ENDPOINT_GLM, '');
    await hostStores().globalState.update(GlobalStateKey.GLM_CODING_PLAN, true);
    await hostStores().globalState.update(GlobalStateKey.GLM_USE_CHINA, true);
    await hostStores().globalState.update(GlobalStateKey.USE_OPENROUTER, true);
  });

  it.each([
    {
      name: 'China Coding Plan',
      useChina: true,
      codingPlan: true,
      expected: {
        route: 'official-coding-plan',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        usageRoute: 'glm-coding-plan-subscription',
      },
    },
    {
      name: 'global Coding Plan',
      useChina: false,
      codingPlan: true,
      expected: {
        route: 'official-coding-plan',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        usageRoute: 'glm-coding-plan-subscription',
      },
    },
    {
      name: 'China regular API',
      useChina: true,
      codingPlan: false,
      expected: {
        route: 'official',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      },
    },
    {
      name: 'global regular API',
      useChina: false,
      codingPlan: false,
      expected: {
        route: 'official',
        baseUrl: 'https://api.z.ai/api/paas/v4',
      },
    },
  ])(
    'resolves the exact $name route',
    async ({ useChina, codingPlan, expected }) => {
      await hostStores().globalState.update(
        GlobalStateKey.USE_OPENROUTER,
        false,
      );
      await hostStores().globalState.update(GlobalStateKey.ENDPOINT_GLM, '');
      await hostStores().globalState.update(
        GlobalStateKey.GLM_CODING_PLAN,
        codingPlan,
      );
      await hostStores().globalState.update(
        GlobalStateKey.GLM_USE_CHINA,
        useChina,
      );

      expect(resolveGlmRoute({ useOpenRouter: false })).toEqual(expected);
    },
  );

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
    'keeps the canonical route, bound endpoint, and subscription usage aligned for $name',
    async ({
      useOpenRouter,
      providerEndpoint,
      modelBaseUrl,
      route,
      baseUrl,
      usageRoute,
    }) => {
      await hostStores().globalState.update(
        GlobalStateKey.USE_OPENROUTER,
        useOpenRouter,
      );
      await hostStores().globalState.update(
        GlobalStateKey.ENDPOINT_GLM,
        providerEndpoint,
      );
      if (modelBaseUrl) MODEL_CONFIGS.glm52.baseUrl = modelBaseUrl;

      const canonical = resolveGlmRoute({
        baseUrl: modelBaseUrl,
        useOpenRouter,
      });
      const endpoint = resolveRouteEndpoint(
        { name: 'glm52', provider: ModelProvider.GLM, baseUrl: modelBaseUrl },
        useOpenRouter,
      );

      expect(canonical).toEqual({
        route,
        baseUrl,
        ...(usageRoute && { usageRoute }),
      });
      expect(endpoint).toMatchObject({ baseUrl });
      expect(endpoint.usageRoute).toBe(usageRoute);
      await expect(
        activeSubscriptionUsageRoute('glm52', hostStores().secrets),
      ).resolves.toBe(usageRoute);
    },
  );

  it('leaves the stored preference alone for a run that declined the plan', async () => {
    await hostStores().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    await hostStores().globalState.update(GlobalStateKey.GLM_CODING_PLAN, true);

    expect(resolveGlmRoute({ useOpenRouter: false }).route).toBe(
      'official-coding-plan',
    );
    expect(
      resolveGlmRoute({
        useOpenRouter: false,
        declinedRoutes: ['glm-coding-plan-subscription'],
      }).route,
    ).toBe('official');
    // The decline is the asking run's, so the user's switch is untouched and
    // a concurrent run still routes through the plan.
    expect(
      hostStores().globalState.get(GlobalStateKey.GLM_CODING_PLAN, false),
    ).toBe(true);
  });
});
