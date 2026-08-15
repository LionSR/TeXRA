// Third-party imports
import { describe, expect, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { ModelHandlerXAI } from '@agent/modelHandlers/openai/modelHandlerXAI';
import { xaiLongContextTier } from '@agent/modelHandlers/openai/xaiLongContextPricing';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

function createXaiHandler(fullName: string): ModelHandlerXAI {
  return new ModelHandlerXAI(
    buildTestModelConfig({
      provider: ModelProvider.XAI,
      name: fullName,
      fullName,
      shortName: fullName,
      inputPrice: 2,
      outputPrice: 6,
      capabilities: { cacheDiscountFactor: 0.25 },
    }),
  );
}

describe('xaiLongContextTier', () => {
  it('carries the documented tier tuple for each current xAI model', () => {
    expect(xaiLongContextTier('grok-4.6')).toStrictEqual({
      thresholdTokens: 200_000,
      inputPrice: 4,
      outputPrice: 12,
    });
    expect(xaiLongContextTier('grok-4.5')).toStrictEqual({
      thresholdTokens: 200_000,
      inputPrice: 4,
      outputPrice: 12,
    });
    expect(xaiLongContextTier('grok-4.3')).toStrictEqual({
      thresholdTokens: 200_000,
      inputPrice: 2.5,
      outputPrice: 5,
    });
  });

  it('has no tier for undocumented or OpenRouter-qualified ids', () => {
    expect(xaiLongContextTier('grok-4-0709')).toBeUndefined();
    expect(xaiLongContextTier('x-ai/grok-4.6')).toBeUndefined();
    expect(xaiLongContextTier('gpt-5.5')).toBeUndefined();
  });

  it('returns a fresh tier object per call', () => {
    expect(xaiLongContextTier('grok-4.6')).not.toBe(
      xaiLongContextTier('grok-4.6'),
    );
  });
});

describe('ModelHandlerXAI long-context pricing', () => {
  it('bills flat rates at the threshold and tier rates past it', () => {
    const handler = createXaiHandler('grok-4.6');

    expect(
      handler.computePrice({
        prompt_tokens: 200_000,
        completion_tokens: 1_000,
        total_tokens: 201_000,
      }),
    ).toBeCloseTo((200_000 * 2 + 1_000 * 6) / 1e6, 12);
    expect(
      handler.computePrice({
        prompt_tokens: 200_001,
        completion_tokens: 1_000,
        total_tokens: 201_001,
      }),
    ).toBeCloseTo((200_001 * 4 + 1_000 * 12) / 1e6, 12);
  });

  it('keeps flat rates for xAI models without a documented tier', () => {
    const handler = createXaiHandler('grok-4-0709');

    expect(
      handler.computePrice({
        prompt_tokens: 500_000,
        completion_tokens: 1_000,
        total_tokens: 501_000,
      }),
    ).toBeCloseTo((500_000 * 2 + 1_000 * 6) / 1e6, 12);
  });
});
