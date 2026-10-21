import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_CONFIGS,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
} from 'llm-zoo';

import { Effect } from 'effect';
import { codexBackendModelId, routeConfig } from '@texra-ai/llm';
import { readModelOptions } from '@model/computeModelOptions';
import { readModelSettings, routeFactsFor } from '@model/modelSettings';
import { withProcessServices } from '@platform/processRuntime';

/** The input window the Codex backend grants the fixture model. */
const CODEX_INPUT_LIMIT = 272_000;
import { testRuntime } from '@test/support/testProcessRuntime';
import { hostStores, installPlatform } from '@test/support/setupPlatform';
import type { CodexSession } from '@texra-ai/llm/node';

/** The secret a ChatGPT session persists under. */
const CODEX_SESSION_SECRET_KEY = 'auth.chatgpt-codex';

/** The config a model runs with on the ChatGPT subscription. */
const chatgptConfig = (config: ModelConfig) =>
  readModelSettings(hostStores()).pipe(
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

const signedInSession: CodexSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAtMs: Date.now() + 10 * 60_000,
  accountId: 'account-id',
};

async function installSubscriptionPlatform(options?: {
  useOpenRouter?: boolean;
  signedIn?: boolean;
}): Promise<void> {
  await installPlatform({
    config: {
      'texra.chatgptCodex.preferSubscription': true,
    },
    globalState: {
      'texra.useOpenRouter': options?.useOpenRouter ?? false,
    },
    secrets:
      options?.signedIn === false
        ? {}
        : { [CODEX_SESSION_SECRET_KEY]: JSON.stringify(signedInSession) },
  });
}

describe('provider capabilities', () => {
  beforeEach(() =>
    installPlatform({
      config: { 'texra.chatgptCodex.preferSubscription': true },
    }),
  );

  it.effect(
    'resolves ChatGPT subscription profile from model routing context',
    () =>
      Effect.gen(function* () {
        const capabilities = yield* chatgptConfig(gpt55Config);

        expect(capabilities).toMatchObject({
          contextWindow: CODEX_INPUT_LIMIT + gpt55Config.maxOutputTokens,
          inputPrice: 0,
          outputPrice: 0,
        });
      }),
  );

  it.effect.each([
    ['openai/gpt-5.6-sol', 272_000],
    ['openai/gpt-5.6-terra', 272_000],
    ['openai/gpt-5.6-luna', 272_000],
    ['openai/gpt-6.1-sol', 500_000],
  ] as const)(
    'caps ChatGPT-subscription %s to the input window Codex grants it (%i)',
    ([id, window]) =>
      Effect.gen(function* () {
        const model = MODEL_CONFIGS[id];
        const capabilities = yield* chatgptConfig(model);

        expect(model.codexSubscription).toEqual({ contextWindow: window });
        expect(capabilities).toMatchObject({
          contextWindow: window + model.maxOutputTokens,
        });
      }),
  );

  describe('context window override', () => {
    afterEach(() => installPlatform());

    it.effect(
      'raises the subscription input and displayed context windows',
      () =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            installPlatform({
              config: {
                'texra.chatgptCodex.preferSubscription': true,
                'texra.chatgptCodex.contextWindowK': 872,
              },
            }),
          );

          expect(yield* chatgptConfig(gpt55Config)).toMatchObject({
            contextWindow: 1_000_000,
          });
        }),
    );

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
});

describe('ChatGPT subscription model routing', () => {
  const prospectiveRoute = () =>
    withProcessServices(
      testRuntime(),
      readModelOptions(hostStores(), ['openai/gpt-5.6-sol']).pipe(
        Effect.map(([option]) => option?.usageRoute),
      ),
    );

  it.effect(
    'keeps eligible OpenAI models on the direct API route when the preference is off',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installPlatform());

        expect(yield* prospectiveRoute()).toBeUndefined();
      }),
  );

  it.effect('does not override OpenRouter routing', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installSubscriptionPlatform({ useOpenRouter: true }),
      );

      expect(yield* prospectiveRoute()).toBeUndefined();
    }),
  );

  it.effect(
    'routes an eligible direct OpenAI model through the preferred subscription',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installSubscriptionPlatform());

        expect(yield* prospectiveRoute()).toBe('chatgpt-subscription');
      }),
  );

  it.effect('reports eligible models inactive while signed out', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installSubscriptionPlatform({ signedIn: false }),
      );

      expect(yield* prospectiveRoute()).toBeUndefined();
    }),
  );
});

describe('codexBackendModelId', () => {
  // The bug this pins: llm-zoo's `shortName` for GPT-5.6 Sol is the bare
  // `gpt-5.6`, which is not a model the Codex backend serves — it answers
  // "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT
  // account", which reads as a plan problem rather than a bad id.
  it.each([
    ['openai/gpt-5.6-sol', 'gpt-5.6-sol'],
    ['openai/gpt-5.6-terra', 'gpt-5.6-terra'],
    ['openai/gpt-5.6-luna', 'gpt-5.6-luna'],
    ['openai/gpt-6-astra', 'gpt-6-astra'],
    ['openai/gpt-5.5-2026-04-23', 'gpt-5.5'],
  ] as const)('sends the backend slug for %s', (ref, slug) => {
    expect(codexBackendModelId(MODEL_CONFIGS[ref])).toBe(slug);
  });

  it('strips the llm-zoo date pin', () => {
    expect(
      codexBackendModelId({
        ref: 'openai/not-a-registry-id',
        id: 'gpt-5.5-2026-04-23',
      }),
    ).toBe('gpt-5.5');
  });

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
