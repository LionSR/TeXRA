// Third-party imports
/**
 * Token usage statistics for tracking model usage and costs.
 */
// Third-party imports
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
 * Extended statistics tracked during agent execution.
 */
export interface ExtendedTokenUsageStats extends TokenUsageStats {
  /** Total elapsed time in seconds */
  elapsedTime?: number;
  /** Tokens read from cache */
  cacheReadInputTokens?: number;
  /** Tokens written to cache */
  cacheCreationInputTokens?: number;
  /** Percentage of tokens served from cache */
  percentageCached?: number;
  /** Tokens used for reasoning */
  reasoningTokens?: number;
  /** Tokens consumed by tool use */
  toolUseTokens?: number;
}

/**
 * Message interface for updating usage stats in the progress view.
 */
export const StreamUsageMessageSchema = z.object({
  command: z.literal('updateUsage'),
  stream: z.string(),
  usageByRun: z
    .record(z.string(), TokenUsageStatsSchema)
    .default({})
    .optional(),
});

export type StreamUsageMessage = z.infer<typeof StreamUsageMessageSchema>;
