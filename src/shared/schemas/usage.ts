// Third-party imports
import { z } from 'zod';

export const TokenUsageStatsSchema = z.strictObject({
  /** Number of input tokens consumed */
  inputTokens: z.number(),
  /** Number of output tokens generated */
  outputTokens: z.number(),
  /** Total cost in USD for the request */
  cost: z.number(),
  /** Tokens read from cache (discounted rate) */
  cacheReadInputTokens: z.number().optional(),
  /** Tokens written to cache (Anthropic: charged at 1.25x input price) */
  cacheCreationInputTokens: z.number().optional(),
});

export type TokenUsageStats = z.infer<typeof TokenUsageStatsSchema>;
