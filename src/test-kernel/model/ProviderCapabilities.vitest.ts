import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_CONFIGS,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
} from 'llm-zoo';

import {
  CODEX_SESSION_SECRET_KEY,
  resetCodexCoordinator,
  type CodexSession,
} from '@auth/codex';
import {
  CODEX_DEFAULT_SUBSCRIPTION_INPUT_LIMIT,
  CODEX_DEFAULT_SUBSCRIPTION_CONTEXT_WINDOW,
  CODEX_GPT56_SUBSCRIPTION_INPUT_LIMIT,
  CODEX_GPT56_SUBSCRIPTION_CONTEXT_WINDOW,
  isCodexSubscriptionActive,
  resolveCodexSubscriptionCapabilitiesForAgentCategory,
  resolveProviderCapabilities,
} from '@model/providerCapabilities';
import { AgentCategory } from '@shared/schemas/agent';
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

const gpt56Config: ModelConfig = {
  ...gpt55Config,
  name: 'gpt56--',
  label: 'GPT-5.6 Luna',
  fullName: 'gpt-5.6-luna',
  shortName: 'gpt-5.6-luna',
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
  toolUseOnly?: boolean;
}): Promise<void> {
  await installPlatform({
    config: {
      'texra.chatgptCodex.preferSubscription': true,
      'texra.chatgptCodex.subscriptionToolUseOnly':
        options?.toolUseOnly ?? false,
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
  it('resolves ChatGPT subscription profile from model routing context', () => {
    const capabilities = resolveProviderCapabilities({
      model: gpt55Config,
      useOpenRouter: false,
    });

    expect(capabilities).toMatchObject({
      authMode: 'chatgpt-subscription',
      contextWindow: CODEX_DEFAULT_SUBSCRIPTION_CONTEXT_WINDOW,
      inputTokenLimit: CODEX_DEFAULT_SUBSCRIPTION_INPUT_LIMIT,
      inputPrice: 0,
      outputPrice: 0,
      usageRoute: 'chatgpt-subscription',
      openAIResponses: {
        backgroundMode: 'disabled',
        streaming: 'forced',
        webSocket: 'global-toggle',
        supportsTokenCounting: false,
        // Manual compaction is supported end-to-end via
        // `ModelHandlerOpenAIResponse`'s client-side summarize-and-resend
        // fallback (#7213) even though the stateful `/responses/compact`
        // endpoint is unusable on this `store: false` backend.
        supportsManualCompaction: true,
        supportsResponseChaining: false,
        storesResponsesServerSide: false,
        supportsInlineInputFileUpload: false,
        supportsToolResultFileUpload: false,
        failWhenFallbackOutputBudgetIsReduced: true,
      },
    });
  });

  it('uses the larger Codex input budget for GPT-5.6', () => {
    const capabilities = resolveProviderCapabilities({
      model: gpt56Config,
      useOpenRouter: false,
    });

    expect(capabilities).toMatchObject({
      contextWindow: CODEX_GPT56_SUBSCRIPTION_CONTEXT_WINDOW,
      inputTokenLimit: CODEX_GPT56_SUBSCRIPTION_INPUT_LIMIT,
    });
  });
});

describe('ChatGPT subscription model routing', () => {
  afterEach(() => {
    resetCodexCoordinator();
  });

  it('keeps eligible OpenAI models on the direct API route when the preference is off', async () => {
    await installPlatform();

    expect(
      resolveCodexSubscriptionCapabilitiesForAgentCategory(
        MODEL_CONFIGS.gpt55,
        false,
        AgentCategory.ToolUse,
      ),
    ).toBeNull();
  });

  it('does not override OpenRouter routing', async () => {
    await installSubscriptionPlatform({ useOpenRouter: true });

    expect(
      resolveCodexSubscriptionCapabilitiesForAgentCategory(
        MODEL_CONFIGS.gpt55,
        true,
        AgentCategory.ToolUse,
      ),
    ).toBeNull();
    await expect(
      isCodexSubscriptionActive('gpt55', AgentCategory.ToolUse),
    ).resolves.toBe(false);
  });

  it('routes an eligible direct OpenAI model through the preferred subscription', async () => {
    await installSubscriptionPlatform();

    expect(
      resolveCodexSubscriptionCapabilitiesForAgentCategory(
        MODEL_CONFIGS.gpt55,
        false,
        AgentCategory.ToolUse,
      ),
    ).not.toBeNull();
  });

  it('restricts subscription routing to tool-use agents when configured', async () => {
    await installSubscriptionPlatform({ toolUseOnly: true });

    expect(
      resolveCodexSubscriptionCapabilitiesForAgentCategory(
        MODEL_CONFIGS.gpt55,
        false,
        AgentCategory.Workflow,
      ),
    ).toBeNull();
    expect(
      resolveCodexSubscriptionCapabilitiesForAgentCategory(
        MODEL_CONFIGS.gpt55,
        false,
        AgentCategory.ToolUse,
      ),
    ).not.toBeNull();
    expect(
      resolveCodexSubscriptionCapabilitiesForAgentCategory(
        MODEL_CONFIGS.gpt55,
        false,
        undefined,
      ),
    ).toBeNull();
    await expect(
      isCodexSubscriptionActive('gpt55', AgentCategory.Workflow),
    ).resolves.toBe(false);
    await expect(
      isCodexSubscriptionActive('gpt55', AgentCategory.ToolUse),
    ).resolves.toBe(true);
  });

  it('reports eligible models inactive while signed out', async () => {
    await installSubscriptionPlatform({ signedIn: false });

    await expect(
      isCodexSubscriptionActive('gpt55', AgentCategory.ToolUse),
    ).resolves.toBe(false);
  });

  it('reports eligible models active for a signed-in preferred subscription', async () => {
    await installSubscriptionPlatform();

    await expect(
      isCodexSubscriptionActive('gpt55', AgentCategory.ToolUse),
    ).resolves.toBe(true);
  });

  it('reports unknown model identifiers inactive', async () => {
    await installSubscriptionPlatform();

    await expect(
      isCodexSubscriptionActive(
        'unknown-subscription-model',
        AgentCategory.ToolUse,
      ),
    ).resolves.toBe(false);
  });
});
