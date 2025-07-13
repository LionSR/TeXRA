// Third-party imports
import { z } from 'zod';

/**
 * Zod schema for token usage statistics.
 */
export const TokenUsageStatsSchema = z
  .object({
    /** Number of input tokens consumed */
    inputTokens: z.number(),
    /** Number of output tokens generated */
    outputTokens: z.number(),
    /** Total cost in USD for the request */
    cost: z.number(),
  })
  .strict();

export type TokenUsageStats = z.infer<typeof TokenUsageStatsSchema>;

/**
 * Zod schema for usage update messages sent to the progress view.
 */
export const StreamUsageMessageSchema = z
  .object({
    command: z.literal('updateUsage'),
    usage: TokenUsageStatsSchema.optional(),
  })
  .strict();

export type StreamUsageMessage = z.infer<typeof StreamUsageMessageSchema>;
