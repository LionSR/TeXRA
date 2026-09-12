// Third-party imports
import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

// Local imports
import {
  xaiCacheDiscountFactor,
  xaiLongContextTier,
  xaiLongContextTierGap,
} from '@agent/modelHandlers/openai/xaiLongContextPricing';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

describe('xaiLongContextTier', () => {
  it('has no tier for undocumented or OpenRouter-qualified ids', () => {
    expect(xaiLongContextTier('grok-4-0709')).toBeUndefined();
    expect(xaiLongContextTier('x-ai/grok-4.6')).toBeUndefined();
    expect(xaiLongContextTier('gpt-5.5')).toBeUndefined();
  });
});

describe('xaiCacheDiscountFactor', () => {
  it('has no factor for undocumented or OpenRouter-qualified ids', () => {
    expect(xaiCacheDiscountFactor('grok-4-0709')).toBeUndefined();
    expect(xaiCacheDiscountFactor('x-ai/grok-4.6')).toBeUndefined();
    expect(xaiCacheDiscountFactor('gpt-5.5')).toBeUndefined();
  });
});

describe('llm-zoo catalog cross-check', () => {
  it('covers every live long-context xAI model in the catalog', () => {
    // Drift tripwire for the hand-maintained table: an llm-zoo bump that
    // adds a long-context xAI model fails here until its tier is verified
    // against docs.x.ai and added to XAI_DOCUMENTED_PRICING.
    expect(
      Object.values(MODEL_CONFIGS).filter((model) =>
        xaiLongContextTierGap(model),
      ),
    ).toEqual([]);
  });
});

describe('xaiLongContextTierGap', () => {
  it('flags a live unlisted xAI model at exactly the documented threshold', () => {
    // The pricing switch is inclusive at 200_000, so the drift tripwire must
    // trip on equality too — a 200_000-window model bills tiered but has no
    // row here.
    expect(
      xaiLongContextTierGap(
        buildTestModelConfig({
          provider: ModelProvider.XAI,
          fullName: 'grok-9',
          contextWindow: 200_000,
        }),
      ),
    ).toBe(true);
  });

  it('spares listed, deprecated, retired, short-window, and non-xAI models', () => {
    const cases = [
      // Listed in the table.
      { fullName: 'grok-4.6', contextWindow: 500_000 },
      // No longer served; xAI will not publish new tiers for these.
      { fullName: 'grok-legacy', contextWindow: 500_000, deprecated: true },
      { fullName: 'grok-dead', contextWindow: 500_000, retired: true },
      // One token below the inclusive threshold.
      { fullName: 'grok-small', contextWindow: 199_999 },
    ] as const;
    for (const overrides of cases) {
      expect(
        xaiLongContextTierGap(
          buildTestModelConfig({ provider: ModelProvider.XAI, ...overrides }),
        ),
      ).toBe(false);
    }
    expect(
      xaiLongContextTierGap(
        buildTestModelConfig({
          provider: ModelProvider.OPENAI,
          fullName: 'gpt-9',
          contextWindow: 1_000_000,
        }),
      ),
    ).toBe(false);
  });
});
