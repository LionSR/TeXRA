/**
 * Anthropic reports `cache_creation_input_tokens` as the total write count and
 * breaks it down only into the TTL buckets it knows, so a turn can carry cache
 * writes that belong to neither bucket. Those bill at the five-minute rate
 * rather than falling out of the turn's cost (#12316).
 */
// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { priceTurnUsage } from '@agent/runtime/run/pricing';
import type { Model, TurnResult } from '@llm/turn';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

/** Per-million rates the fixture bills at; cache writes are 1.25x and 2x. */
const INPUT_PRICE = 3;
const OUTPUT_PRICE = 15;
const WRITE_5M_PRICE = INPUT_PRICE * 1.25;
const WRITE_1H_PRICE = INPUT_PRICE * 2;

/** The turn's non-write cost: uncached input, the cache read, the output. */
const UNCACHED_TOKENS = 1500;
const CACHED_TOKENS = 500;
const OUTPUT_TOKENS = 400;
const NON_WRITE_COST =
  (UNCACHED_TOKENS * INPUT_PRICE +
    CACHED_TOKENS * INPUT_PRICE * 0.1 +
    OUTPUT_TOKENS * OUTPUT_PRICE) /
  1e6;

/** A `Model` the pricing function never calls: it prices reported counts. */
const unusedModel = new Proxy({} as Model, {
  get(_target, property) {
    throw new Error(`Pricing must not reach the model (${String(property)}).`);
  },
});

const boundAnthropic: BoundModel = {
  modelId: 'test-model',
  config: buildTestModelConfig({
    inputPrice: INPUT_PRICE,
    outputPrice: OUTPUT_PRICE,
  }),
  compatibilityKey: 'Anthropic',
  model: unusedModel,
  origin: {
    protocol: 'anthropic-messages',
    codecVersion: 1,
    requestedModel: 'test-model',
    deployment: {
      endpoint: 'https://api.example.test/v1',
      credentialScope: 'anthropic',
    },
  },
  usageRoute: 'api-key',
  contextWindow: 200_000,
  supportsVision: false,
  supportsNativePdf: false,
  supportsNativeAudio: false,
  supportsForcedToolChoice: true,
  wireRouteKey: 'test-route',
  modelRetryRouteKey: 'test-route/test-model',
  routedOnKimiCode: false,
  backgroundCapable: false,
};

function anthropicUsage(breakdown: {
  readonly cacheCreationTokens: number;
  readonly cacheCreation5mTokens: number | null;
  readonly cacheCreation1hTokens: number | null;
}): TurnResult['usage'] {
  return {
    inputTokens: UNCACHED_TOKENS + CACHED_TOKENS,
    outputTokens: OUTPUT_TOKENS,
    totalTokens: UNCACHED_TOKENS + CACHED_TOKENS + OUTPUT_TOKENS,
    cachedInputTokens: CACHED_TOKENS,
    reasoningTokens: null,
    providerUsage: {
      kind: 'anthropic',
      uncachedInputTokens: UNCACHED_TOKENS,
      serviceTier: 'standard',
      inferenceGeo: null,
      ...breakdown,
    },
  };
}

describe('priceTurnUsage on an Anthropic turn', () => {
  it.each([
    {
      name: 'bills the remainder of a two-bucket breakdown at the 5m rate',
      cacheCreationTokens: 1000,
      cacheCreation5mTokens: 600,
      cacheCreation1hTokens: 300,
      billedAt5m: 700,
      billedAt1h: 300,
    },
    {
      name: 'bills everything outside a lone 1h bucket at the 5m rate',
      cacheCreationTokens: 1000,
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: 200,
      billedAt5m: 800,
      billedAt1h: 200,
    },
    {
      name: 'bills the whole total at the 5m rate when no bucket is reported',
      cacheCreationTokens: 1000,
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
      billedAt5m: 1000,
      billedAt1h: 0,
    },
  ])(
    '$name',
    ({
      billedAt5m,
      billedAt1h,
      name: _name,
      ...breakdown
    }: {
      readonly name: string;
      readonly cacheCreationTokens: number;
      readonly cacheCreation5mTokens: number | null;
      readonly cacheCreation1hTokens: number | null;
      readonly billedAt5m: number;
      readonly billedAt1h: number;
    }) => {
      const priced = priceTurnUsage(
        boundAnthropic,
        anthropicUsage(breakdown),
        1234,
        noopTrace,
      );

      expect(priced?.cost).toBeCloseTo(
        NON_WRITE_COST +
          (billedAt5m * WRITE_5M_PRICE + billedAt1h * WRITE_1H_PRICE) / 1e6,
        12,
      );
      expect(priced?.cacheCreationTokens).toBe(breakdown.cacheCreationTokens);
    },
  );
});
