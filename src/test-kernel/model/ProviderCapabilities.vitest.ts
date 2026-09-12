import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_CONFIGS,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
} from 'llm-zoo';

import { resetCodexCoordinator } from '@auth/codex';
import { CODEX_SESSION_SECRET_KEY } from '@auth/codex/codexConstants';
import type { CodexSession } from '@auth/codex/codexSessionTypes';
import { installTexraAccountProbes } from '@controllers/modelAccess/installTexraAccountProbes';
import {
  isCodexSubscriptionActive,
  resolveCodexSubscriptionCapabilities,
} from '@model/providerCapabilities';
import { CHATGPT_CODEX_CONTEXT_WINDOW_SETTING } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';

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
  installTexraAccountProbes();
}

describe('provider capabilities', () => {
  beforeEach(() =>
    installPlatform({
      config: { 'texra.chatgptCodex.preferSubscription': true },
    }),
  );

  it('resolves ChatGPT subscription profile from model routing context', () => {
    const capabilities = resolveCodexSubscriptionCapabilities(
      gpt55Config,
      false,
    );

    expect(capabilities).toMatchObject({
      contextWindow:
        CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.defaultValue +
        gpt55Config.maxOutputTokens,
      inputTokenLimit: CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.defaultValue,
      inputPrice: 0,
      outputPrice: 0,
      usageRoute: 'chatgpt-subscription',
      openAIResponses: {
        backgroundMode: 'disabled',
        streaming: 'forced',
        webSocket: 'global-toggle',
        supportsTokenCounting: false,
        // Manual compaction is supported end-to-end via
        // the Responses model's client-side summarize-and-resend
        // fallback (#7213) even though the stateful `/responses/compact`
        // endpoint is unusable on this `store: false` backend.
        supportsManualCompaction: true,
        supportsResponseChaining: false,
        storesResponsesServerSide: false,
        supportsInlineInputFileUpload: false,
        supportsToolResultFileUpload: false,
      },
    });
  });

  it.each(['gpt56', 'gpt56-', 'gpt56--'] as const)(
    'caps ChatGPT-subscription %s to the Codex 272k input / 400k context budget',
    (id) => {
      const model = MODEL_CONFIGS[id];
      const capabilities = resolveCodexSubscriptionCapabilities(model, false);

      expect(model.codexSubscription).toBe(true);
      expect(capabilities).toMatchObject({
        contextWindow:
          CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.defaultValue +
          model.maxOutputTokens,
        inputTokenLimit: CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.defaultValue,
      });
    },
  );

  describe('context window override', () => {
    afterEach(() => installPlatform());

    it('raises the subscription input and displayed context windows', async () => {
      await installPlatform({
        config: {
          'texra.chatgptCodex.preferSubscription': true,
          'texra.chatgptCodex.contextWindow': 872_000,
        },
      });

      expect(
        resolveCodexSubscriptionCapabilities(gpt55Config, false),
      ).toMatchObject({
        inputTokenLimit: 872_000,
        contextWindow: 1_000_000,
      });
    });

    it('falls back when the configured context window is out of range', async () => {
      await installPlatform({
        config: {
          'texra.chatgptCodex.preferSubscription': true,
          'texra.chatgptCodex.contextWindow': 900_000,
        },
      });

      expect(
        resolveCodexSubscriptionCapabilities(gpt55Config, false),
      ).toMatchObject({
        inputTokenLimit: CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.defaultValue,
      });
    });
  });
});

describe('ChatGPT subscription model routing', () => {
  afterEach(() => {
    resetCodexCoordinator();
  });

  function subscriptionCapabilities(useOpenRouter: boolean) {
    return resolveCodexSubscriptionCapabilities(
      MODEL_CONFIGS.gpt55,
      useOpenRouter,
    );
  }

  it('keeps eligible OpenAI models on the direct API route when the preference is off', async () => {
    await installPlatform();

    expect(subscriptionCapabilities(false)).toBeNull();
  });

  it('does not override OpenRouter routing', async () => {
    await installSubscriptionPlatform({ useOpenRouter: true });

    expect(subscriptionCapabilities(true)).toBeNull();
    await expect(isCodexSubscriptionActive('gpt55')).resolves.toBe(false);
  });

  it('routes an eligible direct OpenAI model through the preferred subscription', async () => {
    await installSubscriptionPlatform();

    expect(subscriptionCapabilities(false)).not.toBeNull();
    await expect(isCodexSubscriptionActive('gpt55')).resolves.toBe(true);
  });

  it('reports eligible models inactive while signed out', async () => {
    await installSubscriptionPlatform({ signedIn: false });

    await expect(isCodexSubscriptionActive('gpt55')).resolves.toBe(false);
  });

  it('reports unknown model identifiers inactive', async () => {
    await installSubscriptionPlatform();

    await expect(
      isCodexSubscriptionActive('unknown-subscription-model'),
    ).resolves.toBe(false);
  });
});
