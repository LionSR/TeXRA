import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

import { Context, Effect, Layer } from 'effect';
import {
  decideModelRoute,
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  OWN_KEY_ROUTE_FACTS,
  ModelProvider,
  ReasoningEffort,
  routeConfig,
} from '@texra-ai/llm';
import { Secrets } from '@texra-ai/harness/plugins';
import { readModelSettings, routeFactsFor } from '@model/modelSettings';
import { FakeHost } from '@test/support/testKernel';
import type { HostRecord } from '@test/support/fakeHost';

/** The input window the Codex backend grants the fixture model. */
const CODEX_INPUT_LIMIT = 272_000;

/** The config a model runs with on the ChatGPT subscription on `host`. */
const chatgptConfig = (host: HostRecord, config: ModelConfig) =>
  readModelSettings(host.roots).pipe(
    Effect.provide(Secrets.layer(host.secrets, host.app.client)),
    Effect.map((settings) =>
      routeConfig(
        config,
        decideModelRoute(config, {
          ...routeFactsFor(settings, []),
          plans: ['chatgpt-subscription'],
        }),
      ),
    ),
  );

const gpt55Config: ModelConfig = {
  ref: 'openai/gpt-5.5-2026-04-23',
  label: 'GPT-5.5',
  id: 'gpt-5.5-2026-04-23',
  shortName: 'gpt-5.5',
  provider: ModelProvider.OPENAI,
  maxOutputTokens: 128_000,
  inputPrice: 5,
  outputPrice: 30,
  contextWindow: 1_050_000,
  // Codex eligibility comes from the registry's codexSubscription entry
  // (see `codexSubscriptionOf` in models/modelRoute.ts), not from
  // tier/naming heuristics.
  capabilities: DEFAULT_MODEL_CAPABILITIES,
  reasoning: { efforts: [ReasoningEffort.XHIGH] },
  openRouterOnly: false,
  codexSubscription: { contextWindow: CODEX_INPUT_LIMIT },
};

describe('provider capabilities', () => {
  it.effect(
    'falls back when the configured context window is out of range',
    () =>
      Effect.gen(function* () {
        const host = Context.get(
          yield* Layer.build(
            FakeHost.layer({
              config: {
                'chatgptCodex.preferSubscription': true,
                'chatgptCodex.contextWindowK': 900,
              },
            }),
          ),
          FakeHost,
        );

        expect(yield* chatgptConfig(host, gpt55Config)).toMatchObject({
          contextWindow: 400_000,
        });
      }),
  );

  it('prices every plan route at zero, the GLM coding plan included', () => {
    const glm: ModelConfig = {
      ...gpt55Config,
      ref: 'glm/glm-5',
      id: 'glm-5',
      provider: ModelProvider.GLM,
      inputPrice: 1,
      outputPrice: 3,
      codexSubscription: undefined,
    };
    const route = decideModelRoute(glm, {
      ...OWN_KEY_ROUTE_FACTS,
      plans: ['glm-coding-plan-subscription'],
    });
    expect(route).toMatchObject({ plan: 'glm-coding-plan-subscription' });
    expect(routeConfig(glm, route)).toMatchObject({
      inputPrice: 0,
      outputPrice: 0,
    });
  });
});
