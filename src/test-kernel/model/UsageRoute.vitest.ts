import { ModelProvider } from 'llm-zoo';
import { describe, expect, it } from 'vitest';

import { KIMI_CODE_BASE_URL } from '@model/kimiCodeConstants';
import { resolveUsageRoute } from '@model/usageRoute';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

const OPENAI_CONFIG = buildTestModelConfig({
  name: 'gpt-test',
  label: 'GPT Test',
  fullName: 'gpt-test',
  provider: ModelProvider.OPENAI,
  maxOutputTokens: 4096,
});

describe('usage route', () => {
  it('distinguishes Kimi Code subscription usage from personal API keys', () => {
    const kimiCodeConfig = buildTestModelConfig(OPENAI_CONFIG, {
      provider: ModelProvider.MOONSHOT,
      kimiSubscription: true,
      baseUrl: KIMI_CODE_BASE_URL,
    });

    expect(resolveUsageRoute(kimiCodeConfig, 'api-key')).toBe(
      'kimi-code-subscription',
    );
    expect(resolveUsageRoute(OPENAI_CONFIG, 'api-key')).toBe('api-key');
  });

  it('preserves ChatGPT, relay, and OpenRouter credential routes', () => {
    expect(resolveUsageRoute(OPENAI_CONFIG, 'chatgpt-subscription')).toBe(
      'chatgpt-subscription',
    );
    expect(resolveUsageRoute(OPENAI_CONFIG, 'relay')).toBe('relay');
    expect(resolveUsageRoute(OPENAI_CONFIG, 'openrouter')).toBe('api-key');
  });
});
