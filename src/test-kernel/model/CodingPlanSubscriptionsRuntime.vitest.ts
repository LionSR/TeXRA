// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect } from 'vitest';

// Local imports
import {
  apiKeySecretName,
  decideModelRoute,
  MODEL_CONFIGS,
  type ModelConfig,
  resolveRouteEndpoint,
} from '@texra-ai/llm';
import { readModelOptions } from '@model/computeModelOptions';
import { readModelSettings, routeFactsFor } from '@model/modelSettings';
import { Secrets } from '@platform/secrets';
import type { DeclinableUsageRoute } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  fakeHostSecrets,
  installedHost,
  setupPlatform,
} from '@test/support/setupPlatform';

const GLM53 = MODEL_CONFIGS['glm/glm-5.3'];

/** The endpoint and plan the decided route binds `config` to. */
const boundEndpoint = (
  config: ModelConfig,
  declinedRoutes?: readonly DeclinableUsageRoute[],
) =>
  Effect.gen(function* () {
    const facts = routeFactsFor(
      yield* readModelSettings(installedHost().roots).pipe(
        Effect.provideService(Secrets, fakeHostSecrets),
      ),
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
      installedHost().roots.globalState.update('texra.endpoint.glm', ''),
    );
    await Effect.runPromise(
      installedHost().roots.globalState.update(
        GlobalStateKey.GLM_CODING_PLAN,
        true,
      ),
    );
    await Effect.runPromise(
      installedHost().roots.globalState.update('texra.glm.useChina', true),
    );
  });

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
        yield* installedHost().roots.globalState.update(
          'texra.endpoint.glm',
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
          (yield* readModelOptions(installedHost().roots, ['glm/glm-5.3']).pipe(
            Effect.provideService(Secrets, fakeHostSecrets),
          ))[0]?.usageRoute,
        ).toBe(usageRoute);
      }),
  );

  it.effect(
    'leaves the stored preference alone for a run that declined the plan',
    () =>
      Effect.gen(function* () {
        yield* installedHost().roots.globalState.update(
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
          yield* installedHost().roots.globalState.get(
            GlobalStateKey.GLM_CODING_PLAN,
          ),
        ).toBe(true);
      }),
  );
});
