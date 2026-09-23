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
import { CODEX_SESSION_SECRET_KEY } from '@auth/codex/codexConstants';
import type { CodexSession } from '@auth/codex/codexSessionTypes';
import { installTexraAccountProbes } from '@controllers/modelAccess/installTexraAccountProbes';
import {
  isCodexSubscriptionActive,
  resolveCodexSubscriptionCapabilities,
  codexBackendModelId,
} from '@model/providerCapabilities';
import { withProcessServices } from '@platform/processRuntime';
import { CHATGPT_CODEX_CONTEXT_WINDOW_SETTING } from '@shared/schemas';

/** The default budget in tokens; the setting itself is stored in thousands. */
const DEFAULT_INPUT_LIMIT =
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.defaultValue *
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.tokensPerUnit;
import { testRuntime } from '@test/support/testProcessRuntime';
import { hostStores, installPlatform } from '@test/support/setupPlatform';

const gpt55Config: ModelConfig = {
  name: 'gpt55',
  label: 'GPT-5.5',
  fullName: 'gpt-5.5-2026-04-23',
  shortName: 'gpt-5.5',
  provider: ModelProvider.OPENAI,
  maxOutputTokens: 128_000,
  inputPrice: 5,
  outputPrice: 30,
  contextWindow: 1_050_000,
  // Codex eligibility comes from the registry's codexSubscription flag
  // (see providerCapabilities.ts), not from tier/naming heuristics.
  capabilities: {
    ...DEFAULT_MODEL_CAPABILITIES,
    reasoningEffort: ReasoningEffort.XHIGH,
  },
  openRouterOnly: false,
  codexSubscription: true,
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
  // Sign-in state reaches the model layer through the seam the hosts install.
  installTexraAccountProbes(hostStores().secrets);
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
        const capabilities = yield* resolveCodexSubscriptionCapabilities(
          hostStores(),
          gpt55Config,
          false,
        );

        expect(capabilities).toMatchObject({
          config: {
            contextWindow: DEFAULT_INPUT_LIMIT + gpt55Config.maxOutputTokens,
            inputPrice: 0,
            outputPrice: 0,
          },
          usageRoute: 'chatgpt-subscription',
        });
      }),
  );

  it.effect.each(['gpt56', 'gpt56-', 'gpt56--'] as const)(
    'caps ChatGPT-subscription %s to the Codex 272k input / 400k context budget',
    (id) =>
      Effect.gen(function* () {
        const model = MODEL_CONFIGS[id];
        const capabilities = yield* resolveCodexSubscriptionCapabilities(
          hostStores(),
          model,
          false,
        );

        expect(model.codexSubscription).toBe(true);
        expect(capabilities).toMatchObject({
          config: {
            contextWindow: DEFAULT_INPUT_LIMIT + model.maxOutputTokens,
          },
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

          expect(
            yield* resolveCodexSubscriptionCapabilities(
              hostStores(),
              gpt55Config,
              false,
            ),
          ).toMatchObject({ config: { contextWindow: 1_000_000 } });
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

          expect(
            yield* resolveCodexSubscriptionCapabilities(
              hostStores(),
              gpt55Config,
              false,
            ),
          ).toMatchObject({
            config: {
              contextWindow: DEFAULT_INPUT_LIMIT + gpt55Config.maxOutputTokens,
            },
          });
        }),
    );
  });
});

describe('ChatGPT subscription model routing', () => {
  function subscriptionCapabilities(useOpenRouter: boolean) {
    return resolveCodexSubscriptionCapabilities(
      hostStores(),
      MODEL_CONFIGS.gpt55,
      useOpenRouter,
    );
  }

  it.effect(
    'keeps eligible OpenAI models on the direct API route when the preference is off',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installPlatform());

        expect(yield* subscriptionCapabilities(false)).toBeNull();
      }),
  );

  it.effect('does not override OpenRouter routing', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installSubscriptionPlatform({ useOpenRouter: true }),
      );

      expect(yield* subscriptionCapabilities(true)).toBeNull();
      expect(
        yield* withProcessServices(
          testRuntime(),
          isCodexSubscriptionActive(hostStores(), 'gpt55'),
        ),
      ).toBe(false);
    }),
  );

  it.effect(
    'routes an eligible direct OpenAI model through the preferred subscription',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installSubscriptionPlatform());

        expect(yield* subscriptionCapabilities(false)).not.toBeNull();
        expect(
          yield* withProcessServices(
            testRuntime(),
            isCodexSubscriptionActive(hostStores(), 'gpt55'),
          ),
        ).toBe(true);
      }),
  );

  it.effect('reports eligible models inactive while signed out', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installSubscriptionPlatform({ signedIn: false }),
      );

      expect(
        yield* withProcessServices(
          testRuntime(),
          isCodexSubscriptionActive(hostStores(), 'gpt55'),
        ),
      ).toBe(false);
    }),
  );

  it.effect('reports unknown model identifiers inactive', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => installSubscriptionPlatform());

      expect(
        yield* withProcessServices(
          testRuntime(),
          isCodexSubscriptionActive(hostStores(), 'unknown-subscription-model'),
        ),
      ).toBe(false);
    }),
  );
});

describe('codexBackendModelId', () => {
  // The bug this pins: llm-zoo's `shortName` for GPT-5.6 Sol is the bare
  // `gpt-5.6`, which is not a model the Codex backend serves — it answers
  // "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT
  // account", which reads as a plan problem rather than a bad id.
  it.each([
    ['gpt56', 'gpt-5.6-sol'],
    ['gpt56-', 'gpt-5.6-terra'],
    ['gpt56--', 'gpt-5.6-luna'],
    ['gpt6', 'gpt-6-astra'],
    ['gpt55', 'gpt-5.5'],
  ])('sends the backend slug for %s', (key, slug) => {
    expect(codexBackendModelId(MODEL_CONFIGS[key])).toBe(slug);
  });

  it('strips the llm-zoo date pin', () => {
    expect(
      codexBackendModelId({
        name: 'not-a-registry-id',
        fullName: 'gpt-5.5-2026-04-23',
      }),
    ).toBe('gpt-5.5');
  });

  // #12873: "Prefer short model names" rewrites `fullName` to `shortName`
  // before the binding reaches here, so the slug must come from the registry.
  it('ignores a fullName the short-name preference already swapped', () => {
    expect(
      codexBackendModelId({ ...MODEL_CONFIGS.gpt56, fullName: 'gpt-5.6' }),
    ).toBe('gpt-5.6-sol');
  });
});
