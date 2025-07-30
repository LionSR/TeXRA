/**
 * Token usage statistics for tracking model usage and costs.
 */
import { z } from 'zod';

export const TokenUsageStatsSchema = z.object({
  /** Number of input tokens consumed */
  inputTokens: z.number(),
  /** Number of output tokens generated */
  outputTokens: z.number(),
  /** Total cost in USD for the request */
  cost: z.number(),
});

export type TokenUsageStats = z.infer<typeof TokenUsageStatsSchema>;

/**
 * Extended usage statistics for detailed logging.
 */
export interface ExtendedTokenUsageStats extends TokenUsageStats {
  /** Total response time in seconds */
  elapsedTime?: number;
  /** Number of tokens retrieved from cache */
  cacheReadInputTokens?: number;
  /** Number of tokens stored in cache */
  cacheCreationInputTokens?: number;
  /** Percentage of cache hits */
  percentageCached?: number;
  /** Number of reasoning tokens generated */
  reasoningTokens?: number;
  /** Number of tokens used for tool calls */
  toolUseTokens?: number;
}

/**
 * Message interface for updating usage stats in the progress view.
 */
export const StreamUsageMessageSchema = z.object({
  command: z.literal('updateUsage'),
  usage: TokenUsageStatsSchema.optional(),
});

export type StreamUsageMessage = z.infer<typeof StreamUsageMessageSchema>;
