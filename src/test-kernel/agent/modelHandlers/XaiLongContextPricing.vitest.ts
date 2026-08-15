// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS, ModelProvider, type ModelConfig } from 'llm-zoo';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { ModelHandlerXAI } from '@agent/modelHandlers/openai/modelHandlerXAI';
import {
  xaiCacheDiscountFactor,
  xaiLongContextTier,
  xaiLongContextTierGap,
} from '@agent/modelHandlers/openai/xaiLongContextPricing';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

/** The real llm-zoo catalog entry — the config production handlers run on. */
function catalogXaiConfig(fullName: string): ModelConfig {
  const config = Object.values(MODEL_CONFIGS).find(
    (model) =>
      model.provider === ModelProvider.XAI && model.fullName === fullName,
  );
  if (!config) throw new Error(`llm-zoo has no xAI model ${fullName}`);
  return config;
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

describe('xaiCacheDiscountFactor', () => {
  it('carries the documented per-model cache factor', () => {
    expect(xaiCacheDiscountFactor('grok-4.3')).toBe(0.16);
    expect(xaiCacheDiscountFactor('grok-4.5')).toBe(0.15);
    expect(xaiCacheDiscountFactor('grok-4.6')).toBe(0.25);
  });

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

  it('pins the tier rows against the catalog short rates', () => {
    // Every documented tier is exactly double the catalog's short rates
    // today; a mismatch on either side means the table needs re-verification
    // against docs.x.ai, not a silent edit.
    const tiered = Object.values(MODEL_CONFIGS).filter(
      (model) =>
        model.provider === ModelProvider.XAI &&
        xaiLongContextTier(model.fullName) !== undefined,
    );
    expect(tiered.map((model) => model.fullName).toSorted()).toEqual([
      'grok-4.3',
      'grok-4.5',
      'grok-4.6',
    ]);
    for (const model of tiered) {
      const tier = xaiLongContextTier(model.fullName);
      expect(tier?.inputPrice).toBe(2 * model.inputPrice);
      expect(tier?.outputPrice).toBe(2 * model.outputPrice);
    }
  });
});

describe('catalog cache-factor pin', () => {
  it('reports the no-discount default for every served xAI model', () => {
    // llm-zoo's xAI entries inherit the default factor of 1 — the reason the
    // handler override exists. If upstream ever ships real factors (a short
    // window would not trip the tier sweep above), prefer the catalog and
    // drop the override table and this pin.
    const served = Object.values(MODEL_CONFIGS).filter(
      (model) => model.provider === ModelProvider.XAI && !model.retired,
    );
    expect(served.length).toBeGreaterThan(0);
    for (const model of served) {
      expect(model.capabilities.cacheDiscountFactor).toBe(1);
    }
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

describe('ModelHandlerXAI long-context pricing', () => {
  it('bills flat rates below the threshold and tier rates once reached', () => {
    const handler = new ModelHandlerXAI(catalogXaiConfig('grok-4.6'));

    expect(
      handler.computePrice({
        prompt_tokens: 199_999,
        completion_tokens: 1_000,
        total_tokens: 200_999,
      }),
    ).toBeCloseTo((199_999 * 2 + 1_000 * 6) / 1e6, 12);
    expect(
      handler.computePrice({
        prompt_tokens: 200_000,
        completion_tokens: 1_000,
        total_tokens: 201_000,
      }),
    ).toBeCloseTo((200_000 * 4 + 1_000 * 12) / 1e6, 12);
  });

  it('keeps flat rates for xAI models without a documented tier', () => {
    const handler = new ModelHandlerXAI(catalogXaiConfig('grok-4-0709'));

    expect(
      handler.computePrice({
        prompt_tokens: 500_000,
        completion_tokens: 1_000,
        total_tokens: 501_000,
      }),
    ).toBeCloseTo((500_000 * 3 + 1_000 * 15) / 1e6, 12);
  });
});

describe('ModelHandlerXAI cache rebate wiring', () => {
  it.each([
    ['grok-4.3', 1.25, 2.5, 0.16],
    ['grok-4.5', 2, 6, 0.15],
    ['grok-4.6', 2, 6, 0.25],
  ] as const)(
    'rebates %s cached tokens at its documented factor on the real catalog config',
    (fullName, inputPrice, outputPrice, factor) => {
      const handler = new ModelHandlerXAI(catalogXaiConfig(fullName));

      expect(
        handler.computePrice({
          prompt_tokens: 100_000,
          completion_tokens: 1_000,
          total_tokens: 101_000,
          prompt_tokens_details: { cached_tokens: 40_000 },
        }),
      ).toBeCloseTo(
        (100_000 * inputPrice +
          1_000 * outputPrice -
          40_000 * inputPrice * (1 - factor)) /
          1e6,
        12,
      );
    },
  );

  it('follows the tier input rate for the rebate past the threshold', () => {
    const handler = new ModelHandlerXAI(catalogXaiConfig('grok-4.6'));

    expect(
      handler.computePrice({
        prompt_tokens: 250_000,
        completion_tokens: 1_000,
        total_tokens: 251_000,
        prompt_tokens_details: { cached_tokens: 40_000 },
      }),
    ).toBeCloseTo((250_000 * 4 + 1_000 * 12 - 40_000 * 4 * 0.75) / 1e6, 12);
  });
});

describe('ModelHandlerXAI tier-gap warning', () => {
  it('warns once when a live long-context xAI model has no documented tier', () => {
    const warn = vi.fn();
    const handler = new ModelHandlerXAI(
      buildTestModelConfig({
        provider: ModelProvider.XAI,
        fullName: 'grok-9',
        contextWindow: 1_000_000,
      }),
    );
    handler.setLogger({ warn } as unknown as AgentTrace);
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    };

    handler.computePrice(usage);
    handler.computePrice(usage);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('grok-9');
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      data: { fullName: 'grok-9', contextWindow: 1_000_000 },
    });
  });

  it('stays quiet for models the table covers', () => {
    const warn = vi.fn();
    const handler = new ModelHandlerXAI(catalogXaiConfig('grok-4.6'));
    handler.setLogger({ warn } as unknown as AgentTrace);

    handler.computePrice({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
