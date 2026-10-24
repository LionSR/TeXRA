// Third-party imports
import { Schema } from 'effect';

// Local imports - canonical model contract
import type { TurnResult } from '../turn.js';

/** One Responses usage receipt, as OpenAI and xAI report it. */
export const ResponsesUsageSchema = Schema.Struct({
  input_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  output_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  // Zhipu reports no total.
  total_tokens: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  input_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        cached_tokens: Schema.optional(
          Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        ),
      }),
    ),
  ),
  output_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        reasoning_tokens: Schema.optional(
          Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        ),
      }),
    ),
  ),
  // xAI's settled cost; only its receipts carry the key, and its
  // `output_tokens` exclude the reasoning tokens it bills on top.
  cost_in_usd_ticks: Schema.optional(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
});

/**
 * The canonical usage of one receipt. A receipt carrying xAI's cost keeps it
 * as `xai` provider evidence.
 */
export function responsesUsage(
  usage: typeof ResponsesUsageSchema.Type,
): NonNullable<TurnResult['usage']> {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens ?? null,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? null,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
    ...(usage.cost_in_usd_ticks !== undefined
      ? {
          providerUsage: {
            kind: 'xai',
            costInUsdTicks: usage.cost_in_usd_ticks,
          },
        }
      : {}),
  };
}
