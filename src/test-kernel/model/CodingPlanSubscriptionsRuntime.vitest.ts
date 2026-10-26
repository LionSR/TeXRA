// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { MODEL_CONFIGS, type ModelConfig } from 'llm-zoo';
import { afterEach, describe, expect } from 'vitest';

// Local imports
import {
  apiKeySecretName,
  decideModelRoute,
  resolveRouteEndpoint,
} from '@texra-ai/llm';
import { readModelOptions } from '@model/computeModelOptions';
import { readModelSettings, routeFactsFor } from '@model/modelSettings';
import type { DeclinableUsageRoute } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { hostStores, setupPlatform } from '@test/support/setupPlatform';

const GLM53 = MODEL_CONFIGS['glm/glm-5.3'];

/** The endpoint and plan the decided route binds `config` to. */
const boundEndpoint = (
  config: ModelConfig,
  declinedRoutes?: readonly DeclinableUsageRoute[],
) =>
  Effect.gen(function* () {
    const facts = routeFactsFor(
      yield* readModelSettings(hostStores()),
      declinedRoutes ?? [],
    );
    const route = decideModelRoute(config, {
      ...facts,
      validation: false,
    });
    if (route.kind !== 'api-key') {
      throw new Error(`unexpected ${route.kind} route`);
    }
    const baseUrl = resolveRouteEndpoint(config, route, facts);
    return route.usageRoute !== 'api-key'
      ? { baseUrl, usageRoute: route.usageRoute }
      : { baseUrl };
  });

describe('coding-plan subscription runtime', () => {
  setupPlatform({
    globalState: {
      [GlobalStateKey.GLM_CODING_PLAN]: true,
      [GlobalStateKey.KIMI_CODE_PREFER]: false,
    },
    secrets: { [apiKeySecretName('glm')]: 'glm-key' },
  });

  afterEach(async () => {
    delete MODEL_CONFIGS['glm/glm-5.3'].baseUrl;
    await Effect.runPromise(
      hostStores().globalState.update(GlobalStateKey.ENDPOINT_GLM, ''),
    );
    await Effect.runPromise(
      hostStores().globalState.update(GlobalStateKey.GLM_CODING_PLAN, true),
    );
    await Effect.runPromise(
      hostStores().globalState.update(GlobalStateKey.GLM_USE_CHINA, true),
    );
  });

  it.effect.each([
    {
      name: 'China Coding Plan',
      useChina: true,
      codingPlan: true,
      expected: {
        baseUrl: 'https://open.bigmodel.cn/api/v1',
        usageRoute: 'glm-coding-plan-subscription',
      },
    },
    {
      name: 'global regular API',
      useChina: false,
      codingPlan: false,
      expected: {
        baseUrl: 'https://api.z.ai/api/v1',
      },
    },
  ])('resolves the exact $name route', ({ useChina, codingPlan, expected }) =>
    Effect.gen(function* () {
      yield* hostStores().globalState.update(GlobalStateKey.ENDPOINT_GLM, '');
      yield* hostStores().globalState.update(
        GlobalStateKey.GLM_CODING_PLAN,
        codingPlan,
      );
      yield* hostStores().globalState.update(
        GlobalStateKey.GLM_USE_CHINA,
        useChina,
      );

      expect(yield* boundEndpoint(GLM53)).toEqual(expected);
    }),
  );

  it.effect.each([
    {
      name: 'Coding Plan',
      providerEndpoint: '',
      modelBaseUrl: undefined,
      baseUrl: 'https://open.bigmodel.cn/api/v1',
      usageRoute: 'glm-coding-plan-subscription',
    },
    {
      name: 'provider custom endpoint',
      providerEndpoint: 'http://proxy.test/api/coding/paas/v4/',
      modelBaseUrl: undefined,
      baseUrl: 'https://proxy.test/api/coding/paas/v4',
      usageRoute: undefined,
    },
    {
      name: 'model custom endpoint',
      providerEndpoint: 'provider.test/v4',
      modelBaseUrl: 'https://model.test/v4',
      baseUrl: 'https://model.test/v4',
      usageRoute: undefined,
    },
  ])(
    'keeps the bound endpoint and subscription usage aligned for $name',
    ({ providerEndpoint, modelBaseUrl, baseUrl, usageRoute }) =>
      Effect.gen(function* () {
        yield* hostStores().globalState.update(
          GlobalStateKey.ENDPOINT_GLM,
          providerEndpoint,
        );
        if (modelBaseUrl) MODEL_CONFIGS['glm/glm-5.3'].baseUrl = modelBaseUrl;

        const endpoint = yield* boundEndpoint({
          ...GLM53,
          baseUrl: modelBaseUrl,
        });

        expect(endpoint).toEqual({
          baseUrl,
          ...(usageRoute && { usageRoute }),
        });
        expect(
          (yield* readModelOptions(hostStores(), ['glm/glm-5.3']))[0]
            ?.usageRoute,
        ).toBe(usageRoute);
      }),
  );

  it.effect(
    'leaves the stored preference alone for a run that declined the plan',
    () =>
      Effect.gen(function* () {
        yield* hostStores().globalState.update(
          GlobalStateKey.GLM_CODING_PLAN,
          true,
        );

        expect((yield* boundEndpoint(GLM53)).usageRoute).toBe(
          'glm-coding-plan-subscription',
        );
        expect(
          yield* boundEndpoint(GLM53, ['glm-coding-plan-subscription']),
        ).toEqual({ baseUrl: expect.stringMatching(/\/api\/v1$/) });
        // The decline is the asking run's, so the user's switch is untouched and
        // a concurrent run still routes through the plan.
        expect(
          yield* hostStores().globalState.get(GlobalStateKey.GLM_CODING_PLAN),
        ).toBe(true);
      }),
  );
});
