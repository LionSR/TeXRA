// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - agent model handlers
import { computeGooglePrice } from '@agent/modelHandlers/google/googleUsage';

const CONFIG = {
  inputPrice: 2,
  outputPrice: 12,
  cacheDiscountFactor: 0.25,
};

describe('Google cache pricing', () => {
  it('rebates cached prompt tokens down to the cache-read rate', () => {
    // cachedContentTokenCount is a subset of promptTokenCount: the 600 cached
    // tokens are billed at inputPrice * cacheDiscountFactor, not full rate.
    const price = computeGooglePrice(
      {
        promptTokenCount: 1000,
        cachedContentTokenCount: 600,
        candidatesTokenCount: 100,
      },
      CONFIG,
    );

    const expected =
      (1000 * 2) / 1e6 + (100 * 12) / 1e6 - (600 * 2 * (1 - 0.25)) / 1e6;
    expect(price).toBeCloseTo(expected, 12);
  });

  it('bills the full input rate when nothing is cached', () => {
    const price = computeGooglePrice(
      {
        promptTokenCount: 1000,
        candidatesTokenCount: 100,
      },
      CONFIG,
    );

    expect(price).toBeCloseTo((1000 * 2) / 1e6 + (100 * 12) / 1e6, 12);
  });
});
