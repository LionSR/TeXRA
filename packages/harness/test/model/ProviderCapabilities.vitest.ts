import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

import { Context, Effect, Layer } from 'effect';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
  ReasoningEffort,
  routeConfig,
} from '@texra-ai/llm';
import { Secrets } from '@texra-ai/harness/host';
import { readModelSettings, routeFactsFor } from '@model/modelSettings';
import { FakeHost } from '@test/support/testKernel';
import type { FakeHost as HostRecord } from '@test/support/setupPlatform';

/** The input window the Codex backend grants the fixture model. */
const CODEX_INPUT_LIMIT = 272_000;

/** The config a model runs with on the ChatGPT subscription on `host`. */
const chatgptConfig = (host: HostRecord, config: ModelConfig) =>
  readModelSettings(host.roots).pipe(
    Effect.provide(Secrets.layer(host.secrets)),
    Effect.map((settings) => routeFactsFor(settings, [])),
    Effect.map((facts) =>
      routeConfig(config, {
        kind: 'chatgpt-subscription',
        endpoint: 'https://api.openai.com/v1',
        contextWindow:
          facts.chatgptContextWindow ??
          config.codexSubscription?.contextWindow ??
          Number.NaN,
      }),
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
          contextWindow: CODEX_INPUT_LIMIT + gpt55Config.maxOutputTokens,
        });
      }),
  );
});
