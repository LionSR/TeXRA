import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
} from 'llm-zoo';

import {
  CODEX_DEFAULT_SUBSCRIPTION_INPUT_LIMIT,
  CODEX_DEFAULT_SUBSCRIPTION_CONTEXT_WINDOW,
  CODEX_GPT56_SUBSCRIPTION_INPUT_LIMIT,
  CODEX_GPT56_SUBSCRIPTION_CONTEXT_WINDOW,
  resolveProviderCapabilities,
} from '@model/providerCapabilities';

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
