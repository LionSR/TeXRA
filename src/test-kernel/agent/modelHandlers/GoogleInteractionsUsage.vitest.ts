// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - agent model handlers
import {
  computeGoogleInteractionsPrice,
  normalizeGoogleInteractionsUsage,
} from '@agent/modelHandlers/google/googleInteractionsUsage';
import type { Interactions } from '@google/genai';

const CONFIG = {
  inputPrice: 2,
  outputPrice: 12,
  cacheDiscountFactor: 0.25,
};

function usage(fields: Partial<Interactions.Usage>): Interactions.Usage {
  return fields as Interactions.Usage;
}

describe('Google Interactions usage', () => {
  it('prices cached input and visible output', () => {
    const interactionsPrice = computeGoogleInteractionsPrice(
      usage({
        total_input_tokens: 1000,
        total_cached_tokens: 600,
        total_output_tokens: 100,
      }),
      CONFIG,
    );

    expect(interactionsPrice).toBeCloseTo(
      (400 * 2) / 1e6 + (600 * 2 * 0.25) / 1e6 + (100 * 12) / 1e6,
      12,
    );
  });

  it('does not double-count thought tokens (mirrors candidates + thoughts)', () => {
    // Interactions reports visible output and thoughts separately.
    const interactionsPrice = computeGoogleInteractionsPrice(
      usage({
        total_input_tokens: 1000,
        total_output_tokens: 100,
        total_thought_tokens: 40,
      }),
      CONFIG,
    );

    // Explicit: output billed once at 140 tokens, not 100 + a 40-token surcharge.
    expect(interactionsPrice).toBeCloseTo(
      (1000 * 2) / 1e6 + (140 * 12) / 1e6,
      12,
    );
  });

  it('normalizes the snake_case totals into the unified shape', () => {
    const normalized = normalizeGoogleInteractionsUsage(
      usage({
        total_input_tokens: 1000,
        total_tool_use_tokens: 50,
        total_output_tokens: 100,
        total_thought_tokens: 40,
        total_cached_tokens: 600,
      }),
      1234,
      CONFIG,
    );

    expect(normalized.provider).toBe('google');
    expect(normalized.inputTokens).toBe(1050); // input + tool-use
    expect(normalized.outputTokens).toBe(140); // visible output + thoughts
    expect(normalized.reasoningTokens).toBe(40);
    expect(normalized.cachedInputTokens).toBe(600);
    expect(normalized.toolUsePromptTokens).toBe(50);
    expect(normalized.responseTimeMs).toBe(1234);
  });

  it('returns a zeroed usage for a null payload', () => {
    expect(computeGoogleInteractionsPrice(null, CONFIG)).toBe(0);
    const normalized = normalizeGoogleInteractionsUsage(null, 5, CONFIG);
    expect(normalized.inputTokens).toBe(0);
    expect(normalized.outputTokens).toBe(0);
    expect(normalized.cost).toBe(0);
  });
});
