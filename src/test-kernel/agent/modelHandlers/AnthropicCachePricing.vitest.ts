// Third-party imports
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from 'llm-zoo';
import { describe, expect, it } from 'vitest';

// Local imports - agent model handlers
import { ModelHandlerAnthropic } from '@agent/modelHandlers/modelHandlerAnthropic';

function createHandler(): ModelHandlerAnthropic {
  return new ModelHandlerAnthropic({
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
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsPromptCaching: true,
    },
    openRouterOnly: false,
  });
}

describe('Anthropic cache pricing', () => {
  it('prices cache creation by TTL breakdown when Anthropic reports it', () => {
    const price = createHandler().computePrice({
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 30,
      cache_creation: {
        ephemeral_5m_input_tokens: 10,
        ephemeral_1h_input_tokens: 20,
      },
      server_tool_use: null,
      service_tier: 'standard',
    } as any);

    const expected =
      (1000 * 3) / 1e6 +
      (100 * 15) / 1e6 +
      (10 * 3 * 1.25) / 1e6 +
      (20 * 3 * 2) / 1e6;
    expect(price).toBeCloseTo(expected, 12);
  });

  it('falls back to 5-minute pricing when the TTL breakdown is absent', () => {
    const price = createHandler().computePrice({
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 30,
      cache_creation: {},
      server_tool_use: null,
      service_tier: 'standard',
    } as any);

    const expected =
      (1000 * 3) / 1e6 + (100 * 15) / 1e6 + (30 * 3 * 1.25) / 1e6;
    expect(price).toBeCloseTo(expected, 12);
  });
});
