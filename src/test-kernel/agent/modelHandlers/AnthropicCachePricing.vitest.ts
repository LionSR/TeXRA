// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { describe, expect, it } from 'vitest';

// Local imports - agent model handlers
import { ModelHandlerAnthropic } from '@agent/modelHandlers/anthropic/modelHandlerAnthropic';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

function createHandler(): ModelHandlerAnthropic {
  return new ModelHandlerAnthropic(
    buildTestModelConfig({
      name: 'test-anthropic',
      label: 'Test Anthropic',
      fullName: 'claude-test',
      shortName: 'claude-test',
      provider: ModelProvider.ANTHROPIC,
      maxOutputTokens: 1024,
      inputPrice: 3,
      outputPrice: 15,
      contextWindow: 200000,
      capabilities: {
        supportsPromptCaching: true,
      },
      openRouterOnly: false,
    }),
  );
}

describe('Anthropic cache pricing', () => {
  it.each([
    {
      name: 'prices cache creation by TTL breakdown when Anthropic reports it',
      cacheCreation: {
        ephemeral_5m_input_tokens: 10,
        ephemeral_1h_input_tokens: 20,
      },
      expected:
        (1000 * 3) / 1e6 +
        (100 * 15) / 1e6 +
        (10 * 3 * 1.25) / 1e6 +
        (20 * 3 * 2) / 1e6,
    },
    {
      name: 'falls back to 5-minute pricing when the TTL breakdown is absent',
      cacheCreation: {},
      expected: (1000 * 3) / 1e6 + (100 * 15) / 1e6 + (30 * 3 * 1.25) / 1e6,
    },
  ])('$name', ({ cacheCreation, expected }) => {
    const price = createHandler().computePrice({
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 30,
      cache_creation: cacheCreation,
      server_tool_use: null,
      service_tier: 'standard',
    } as any);

    expect(price).toBeCloseTo(expected, 12);
  });
});
