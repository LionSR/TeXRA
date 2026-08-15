// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - agent model handlers
import {
  computeStandardPrice,
  type StandardPricingConfig,
} from '@agent/modelHandlers/support/priceUtils';

// grok-4.6's documented rates: $2/$6 flat, doubling to $4/$12 past 200k
// prompt tokens, with cached tokens at 25% of the input rate in both tiers.
const TIERED_CONFIG: StandardPricingConfig = {
  inputPrice: 2,
  outputPrice: 6,
  cacheDiscountFactor: 0.25,
  longContextTier: { thresholdTokens: 200_000, inputPrice: 4, outputPrice: 12 },
};

describe('computeStandardPrice long-context tier', () => {
  it('bills the flat rates when the prompt ends exactly at the threshold', () => {
    const price = computeStandardPrice(
      {
        inputTokens: 200_000,
        outputTokens: 1_000,
        cachedTokens: 50_000,
        reasoningTokens: 500,
      },
      TIERED_CONFIG,
    );

    expect(price).toBeCloseTo(
      (200_000 * 2 + 1_000 * 6 + 500 * 6 - 50_000 * 2 * 0.75) / 1e6,
      12,
    );
  });

  it('switches the complete pricing tuple once the prompt crosses the threshold', () => {
    const price = computeStandardPrice(
      {
        inputTokens: 200_001,
        outputTokens: 1_000,
        cachedTokens: 50_000,
        reasoningTokens: 500,
      },
      TIERED_CONFIG,
    );

    // Every prompt token rebills at $4 (not just the excess), output and
    // reasoning rise to $12, and the cache rebate follows the tier's rate.
    expect(price).toBeCloseTo(
      (200_001 * 4 + 1_000 * 12 + 500 * 12 - 50_000 * 4 * 0.75) / 1e6,
      12,
    );
  });

  it('counts cached tokens toward the threshold', () => {
    // 150k uncached + 60k cached = 210k total prompt tokens.
    const price = computeStandardPrice(
      { inputTokens: 210_000, outputTokens: 0, cachedTokens: 60_000 },
      TIERED_CONFIG,
    );

    expect(price).toBeCloseTo((210_000 * 4 - 60_000 * 4 * 0.75) / 1e6, 12);
  });

  it('keeps flat rates for a config without a tier, however long the prompt', () => {
    const price = computeStandardPrice(
      { inputTokens: 500_000, outputTokens: 1_000 },
      { inputPrice: 2, outputPrice: 6, cacheDiscountFactor: 0.25 },
    );

    expect(price).toBeCloseTo((500_000 * 2 + 1_000 * 6) / 1e6, 12);
  });
});
