// Third-party imports
import { z } from 'zod';

// Local imports - canonical model contract
import type { TurnResult } from './turn.js';

/** One Responses usage receipt, as OpenAI and xAI report it. */
export const ResponsesUsageSchema = z.object({
  input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
  // Zhipu reports no total.
  total_tokens: z.int().nonnegative().optional(),
  input_tokens_details: z
    .object({ cached_tokens: z.int().nonnegative().nullish() })
    .nullish(),
  output_tokens_details: z
    .object({ reasoning_tokens: z.int().nonnegative().nullish() })
    .nullish(),
  // xAI's settled cost; only its receipts carry the key, and its
  // `output_tokens` exclude the reasoning tokens it bills on top.
  cost_in_usd_ticks: z.int().nonnegative().nullish(),
});

/**
 * The canonical usage of one receipt. A receipt carrying xAI's cost keeps it,
 * with the response's service tier, as `xai` provider evidence.
 */
export function responsesUsage(
  usage: z.infer<typeof ResponsesUsageSchema>,
  serviceTier: string | null | undefined,
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
            serviceTier:
              serviceTier === 'default' || serviceTier === 'priority'
                ? serviceTier
                : null,
          },
        }
      : {}),
  };
}
