// Third-party imports
import { Schema } from 'effect';

// Local imports - canonical model contract
import { CountSchema } from '../protocol.js';
import type { TurnResult } from '../turn.js';

/** One Responses usage receipt, as OpenAI and xAI report it. */
export const ResponsesUsageSchema = Schema.Struct({
  input_tokens: CountSchema,
  output_tokens: CountSchema,
  // Zhipu reports no total.
  total_tokens: Schema.optional(CountSchema),
  input_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        cached_tokens: Schema.optional(Schema.NullOr(CountSchema)),
        cache_write_tokens: Schema.optional(Schema.NullOr(CountSchema)),
        // Only the models that bill cache writes (GPT-5.6 and later) split
        // them by the cache lifetime requested.
        cache_write_tokens_details: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              ttl_30m_tokens: CountSchema,
              ttl_12h_tokens: CountSchema,
            }),
          ),
        ),
      }),
    ),
  ),
  output_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        reasoning_tokens: Schema.optional(Schema.NullOr(CountSchema)),
      }),
    ),
  ),
  // xAI's final cost; only its receipts carry the key, and its
  // `output_tokens` exclude the reasoning tokens it bills on top.
  cost_in_usd_ticks: Schema.optional(Schema.NullOr(CountSchema)),
});

/**
 * The canonical usage of one receipt. A receipt carrying xAI's cost keeps it
 * as `xai` provider evidence, and one splitting its cache writes by lifetime
 * keeps the split as `openai` evidence.
 */
export function responsesUsage(
  usage: typeof ResponsesUsageSchema.Type,
): NonNullable<TurnResult['usage']> {
  const writes = usage.input_tokens_details?.cache_write_tokens_details;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens ?? null,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? null,
    cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens ?? null,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
    toolUsePromptTokens: null,
    ...(usage.cost_in_usd_ticks !== undefined
      ? {
          providerUsage: {
            kind: 'xai',
            costInUsdTicks: usage.cost_in_usd_ticks,
          },
        }
      : writes != null
        ? {
            providerUsage: {
              kind: 'openai',
              cacheWrite30mTokens: writes.ttl_30m_tokens,
              cacheWrite12hTokens: writes.ttl_12h_tokens,
            },
          }
        : {}),
  };
}
