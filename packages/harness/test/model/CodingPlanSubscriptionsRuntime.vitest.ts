// Third-party imports
import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

// Local imports
import {
  apiKeySecretName,
  decideModelRoute,
  MODEL_CONFIGS,
  type ModelConfig,
} from '@texra-ai/llm';
import {
  type DeclinableUsageRoute,
  GLM_CODING_PLAN_SETTING,
  KIMI_CODE_PREFER_SETTING,
} from '@texra-ai/harness/schemas';
import { readModelOptions } from '@texra-ai/harness/host';
import { Secrets } from '@texra-ai/harness/plugins';
import { readModelSettings, routeFactsFor } from '@model/modelSettings';
import { FakeHost } from '@test/support/testKernel';

const GLM53 = MODEL_CONFIGS['glm/glm-5.3'];

/** `effect` reading the test host's secrets as its `Secrets`, with the
 *  subscription accounts over them. */
const withHostSecrets = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  FakeHost.use((host) =>
    effect.pipe(Effect.provide(Secrets.layer(host.secrets))),
  );

/** The endpoint and plan the decided route binds `config` to. */
const boundEndpoint = (
  config: ModelConfig,
  declinedRoutes?: readonly DeclinableUsageRoute[],
) =>
  Effect.gen(function* () {
    const { roots } = yield* FakeHost;
    const facts = routeFactsFor(
      yield* readModelSettings(roots).pipe(withHostSecrets),
      declinedRoutes ?? [],
    );
    const route = decideModelRoute(config, facts);
    if (route.kind !== 'api-key') {
      throw new Error(`unexpected ${route.kind} route`);
    }
    const baseUrl = route.endpoint;
    return route.plan !== null
      ? { baseUrl, usageRoute: route.plan }
      : { baseUrl };
  });

// Each test's host is its own, so the state a case writes reaches no other.
layer(
  FakeHost.layer({
    globalState: {
      [GLM_CODING_PLAN_SETTING.key]: true,
      [KIMI_CODE_PREFER_SETTING.key]: false,
    },
    secrets: { [apiKeySecretName('glm')]: 'glm-key' },
  }),
  { buildPerTest: true },
)('coding-plan subscription runtime', (it) => {
  afterEach(() => {
    delete MODEL_CONFIGS['glm/glm-5.3'].baseUrl;
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
        const { roots } = yield* FakeHost;
        yield* roots.globalState.update('endpoint.glm', providerEndpoint);
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
          (yield* readModelOptions(roots, ['glm/glm-5.3']).pipe(
            withHostSecrets,
          ))[0]?.usageRoute,
        ).toBe(usageRoute);
      }),
  );

  it.effect(
    'leaves the stored preference alone for a run that declined the plan',
    () =>
      Effect.gen(function* () {
        const { roots } = yield* FakeHost;
        yield* roots.globalState.update(GLM_CODING_PLAN_SETTING.key, true);

        expect((yield* boundEndpoint(GLM53)).usageRoute).toBe(
          'glm-coding-plan-subscription',
        );
        expect(
          yield* boundEndpoint(GLM53, ['glm-coding-plan-subscription']),
        ).toEqual({ baseUrl: expect.stringMatching(/\/api\/v1$/) });
        // The decline is the asking run's, so the user's switch is untouched and
        // a concurrent run still routes through the plan.
        expect(yield* roots.globalState.get(GLM_CODING_PLAN_SETTING.key)).toBe(
          true,
        );
      }),
  );
});
