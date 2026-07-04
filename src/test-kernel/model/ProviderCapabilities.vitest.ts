import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';

import {
  CODEX_SUBSCRIPTION_CONTEXT_WINDOW,
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
  capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
  openRouterOnly: false,
};

describe('provider capabilities', () => {
  it('resolves ChatGPT subscription profile from model routing context', () => {
    const capabilities = resolveProviderCapabilities({
      model: gpt55Config,
      useOpenRouter: false,
    });

    expect(capabilities).toMatchObject({
      authMode: 'chatgpt-subscription',
      contextWindow: CODEX_SUBSCRIPTION_CONTEXT_WINDOW,
      inputPrice: 0,
      outputPrice: 0,
      usageRoute: 'chatgpt-subscription',
      openAIResponses: {
        backgroundMode: 'disabled',
        streaming: 'forced',
        webSocket: 'global-toggle',
        supportsTokenCounting: false,
        supportsManualCompaction: false,
        supportsResponseChaining: false,
        storesResponsesServerSide: false,
        supportsInlineInputFileUpload: false,
        supportsToolResultFileUpload: false,
        failWhenFallbackOutputBudgetIsReduced: true,
      },
    });
  });
});
