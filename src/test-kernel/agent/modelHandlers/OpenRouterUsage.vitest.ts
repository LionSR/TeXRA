import { describe, expect, it } from 'vitest';

import {
  computeOpenRouterPrice,
  normalizeOpenRouterUsage,
} from '@agent/modelHandlers/openrouter/openRouterUsage';
import type { ChatUsage } from '@openrouter/sdk/models';

const CONFIG = {
  inputPrice: 2,
  outputPrice: 12,
  cacheDiscountFactor: 0.25,
};

function usage(fields: Partial<ChatUsage> = {}): ChatUsage {
  return {
    promptTokens: 1000,
    completionTokens: 100,
    totalTokens: 1100,
    ...fields,
  };
}

const STATIC_PRICE = (1000 * 2 + 100 * 12) / 1e6;

describe('OpenRouter usage pricing', () => {
  it('prefers native cost and surfaces it through normalization', () => {
    const raw = usage({ cost: 0.123 });

    expect(computeOpenRouterPrice(raw, CONFIG)).toBe(0.123);
    expect(normalizeOpenRouterUsage(raw, 50, 'openrouter', CONFIG).cost).toBe(
      0.123,
    );
  });

  it('preserves a native zero cost', () => {
    expect(computeOpenRouterPrice(usage({ cost: 0 }), CONFIG)).toBe(0);
  });

  it('keeps static full-inference pricing for BYOK usage', () => {
    expect(
      computeOpenRouterPrice(
        usage({
          cost: 0.0001,
          isByok: true,
          costDetails: {
            upstreamInferenceCost: 0.5,
            upstreamInferencePromptCost: 0.3,
            upstreamInferenceCompletionsCost: 0.2,
          },
        }),
        CONFIG,
      ),
    ).toBeCloseTo(STATIC_PRICE, 12);
  });

  it('falls back to static pricing when native cost is absent', () => {
    expect(computeOpenRouterPrice(usage(), CONFIG)).toBeCloseTo(
      STATIC_PRICE,
      12,
    );
  });
});
