// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';
import { afterEach, beforeEach, describe, expect } from 'vitest';

// Local imports
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import { readProspectiveUsageRoute } from '@model/computeModelOptions';
import { resolveRouteEndpoint } from '@model/routeEndpoint';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { hostStores, setupPlatform } from '@test/support/setupPlatform';

const GLM52 = { name: 'glm52', provider: ModelProvider.GLM } as const;

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
    await Effect.runPromise(
      hostStores().globalState.update(GlobalStateKey.ENDPOINT_GLM, ''),
    );
    await Effect.runPromise(
      hostStores().globalState.update(GlobalStateKey.GLM_CODING_PLAN, true),
    );
    await Effect.runPromise(
      hostStores().globalState.update(GlobalStateKey.GLM_USE_CHINA, true),
    );
    await Effect.runPromise(
      hostStores().globalState.update(GlobalStateKey.USE_OPENROUTER, true),
    );
  });

  it.effect.each([
    {
      name: 'China Coding Plan',
      useChina: true,
      codingPlan: true,
      expected: {
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        usageRoute: 'glm-coding-plan-subscription',
      },
    },
    {
      name: 'global Coding Plan',
      useChina: false,
      codingPlan: true,
      expected: {
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        usageRoute: 'glm-coding-plan-subscription',
      },
    },
    {
      name: 'China regular API',
      useChina: true,
      codingPlan: false,
      expected: {
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      },
    },
    {
      name: 'global regular API',
      useChina: false,
      codingPlan: false,
      expected: {
        baseUrl: 'https://api.z.ai/api/paas/v4',
      },
    },
  ])('resolves the exact $name route', ({ useChina, codingPlan, expected }) =>
    Effect.gen(function* () {
      yield* hostStores().globalState.update(
        GlobalStateKey.USE_OPENROUTER,
        false,
      );
      yield* hostStores().globalState.update(GlobalStateKey.ENDPOINT_GLM, '');
      yield* hostStores().globalState.update(
        GlobalStateKey.GLM_CODING_PLAN,
        codingPlan,
      );
      yield* hostStores().globalState.update(
        GlobalStateKey.GLM_USE_CHINA,
        useChina,
      );

      expect(yield* resolveRouteEndpoint(hostStores(), GLM52, false)).toEqual(
        expected,
      );
    }),
  );

  it.effect.each([
    {
      name: 'Coding Plan',
      useOpenRouter: false,
      providerEndpoint: '',
      modelBaseUrl: undefined,
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      usageRoute: 'glm-coding-plan-subscription',
    },
    {
      name: 'provider custom endpoint',
      useOpenRouter: false,
      providerEndpoint: 'http://proxy.test/api/coding/paas/v4/',
      modelBaseUrl: undefined,
      baseUrl: 'https://proxy.test/api/coding/paas/v4',
      usageRoute: undefined,
    },
    {
      name: 'model custom endpoint',
      useOpenRouter: true,
      providerEndpoint: 'provider.test/v4',
      modelBaseUrl: 'https://model.test/v4',
      baseUrl: 'https://model.test/v4',
      usageRoute: undefined,
    },
    {
      name: 'OpenRouter',
      useOpenRouter: true,
      providerEndpoint: 'provider.test/v4',
      modelBaseUrl: undefined,
      baseUrl: 'https://openrouter.ai/api/v1',
      usageRoute: undefined,
    },
  ])(
    'keeps the bound endpoint and subscription usage aligned for $name',
    ({ useOpenRouter, providerEndpoint, modelBaseUrl, baseUrl, usageRoute }) =>
      Effect.gen(function* () {
        yield* hostStores().globalState.update(
          GlobalStateKey.USE_OPENROUTER,
          useOpenRouter,
        );
        yield* hostStores().globalState.update(
          GlobalStateKey.ENDPOINT_GLM,
          providerEndpoint,
        );
        if (modelBaseUrl) MODEL_CONFIGS.glm52.baseUrl = modelBaseUrl;

        const endpoint = yield* resolveRouteEndpoint(
          hostStores(),
          { ...GLM52, baseUrl: modelBaseUrl },
          useOpenRouter,
        );

        expect(endpoint).toEqual({
          baseUrl,
          ...(usageRoute && { usageRoute }),
        });
        expect(
          yield* readProspectiveUsageRoute(hostStores(), 'glm52').pipe(
            Effect.provide(
              LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
            ),
          ),
        ).toBe(usageRoute);
      }),
  );

  it.effect(
    'leaves the stored preference alone for a run that declined the plan',
    () =>
      Effect.gen(function* () {
        yield* hostStores().globalState.update(
          GlobalStateKey.USE_OPENROUTER,
          false,
        );
        yield* hostStores().globalState.update(
          GlobalStateKey.GLM_CODING_PLAN,
          true,
        );

        expect(
          (yield* resolveRouteEndpoint(hostStores(), GLM52, false)).usageRoute,
        ).toBe('glm-coding-plan-subscription');
        expect(
          yield* resolveRouteEndpoint(hostStores(), GLM52, false, [
            'glm-coding-plan-subscription',
          ]),
        ).toEqual({ baseUrl: expect.stringMatching(/\/api\/paas\/v4$/) });
        // The decline is the asking run's, so the user's switch is untouched and
        // a concurrent run still routes through the plan.
        expect(
          yield* hostStores().globalState.get(
            GlobalStateKey.GLM_CODING_PLAN,
            false,
          ),
        ).toBe(true);
      }),
  );
});
