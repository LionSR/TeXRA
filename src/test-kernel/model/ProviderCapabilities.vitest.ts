import { it } from '@effect/vitest';
import { afterEach, describe, expect } from 'vitest';

import { Effect } from 'effect';
import {
  codexBackendModelId,
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_CONFIGS,
  type ModelConfig,
  ModelProvider,
  ReasoningEffort,
  routeConfig,
} from '@texra-ai/llm';
import { readModelSettings, routeFactsFor } from '@model/modelSettings';
import { Secrets } from '@platform/secrets';
import {
  fakeHostSecrets,
  installedHost,
  installPlatform,
} from '@test/support/setupPlatform';

/** The input window the Codex backend grants the fixture model. */
const CODEX_INPUT_LIMIT = 272_000;

/** The config a model runs with on the ChatGPT subscription. */
const chatgptConfig = (config: ModelConfig) =>
  readModelSettings(installedHost().roots).pipe(
    Effect.provideService(Secrets, fakeHostSecrets),
    Effect.map((settings) => routeFactsFor(settings, [])),
    Effect.map((facts) =>
      routeConfig(
        config,
        {
          kind: 'chatgpt-subscription',
          contextWindow: config.codexSubscription?.contextWindow ?? Number.NaN,
        },
        facts,
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
  afterEach(() => installPlatform());

  it.effect(
    'falls back when the configured context window is out of range',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            config: {
              'texra.chatgptCodex.preferSubscription': true,
              'texra.chatgptCodex.contextWindowK': 900,
            },
          }),
        );

        expect(yield* chatgptConfig(gpt55Config)).toMatchObject({
          contextWindow: CODEX_INPUT_LIMIT + gpt55Config.maxOutputTokens,
        });
      }),
  );
});

describe('codexBackendModelId', () => {
  // The bug this pins: llm-zoo's `shortName` for GPT-5.6 Sol is the bare
  // `gpt-5.6`, which is not a model the Codex backend serves — it answers
  // "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT
  // account", which reads as a plan problem rather than a bad id.
  // #12873: "Prefer short model names" rewrites `id` to `shortName`
  // before the binding reaches here, so the slug must come from the registry.
  it('ignores an id the short-name preference already swapped', () => {
    expect(
      codexBackendModelId({
        ...MODEL_CONFIGS['openai/gpt-5.6-sol'],
        id: 'gpt-5.6',
      }),
    ).toBe('gpt-5.6-sol');
  });
});
