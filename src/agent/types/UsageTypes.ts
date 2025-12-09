/**
 * Token usage statistics for tracking model usage and costs.
 */
// Third-party imports
import { z } from 'zod';

export const TokenUsageStatsSchema = z.strictObject({
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
export const ExtendedTokenUsageStatsSchema = TokenUsageStatsSchema.extend({
  /** Total elapsed time in seconds */
  elapsedTime: z.number().optional(),
  /** Tokens read from cache */
  cacheReadInputTokens: z.number().optional(),
  /** Tokens written to cache */
  cacheCreationInputTokens: z.number().optional(),
  /** Percentage of tokens served from cache */
  percentageCached: z.number().optional(),
  /** Tokens used for reasoning */
  reasoningTokens: z.number().optional(),
  /** Tokens consumed by tool use */
  toolUseTokens: z.number().optional(),
});

export type ExtendedTokenUsageStats = z.infer<
  typeof ExtendedTokenUsageStatsSchema
>;

/**
 * Usage statistics for persistence in the progress view.
 * Extends base stats with optional extended metrics.
 *
 * This schema bridges ExtendedTokenUsageStats (used during execution)
 * and persistence storage, preserving valuable metrics like caching
 * efficiency and reasoning token usage across sessions.
 */
export const PersistedUsageStatsSchema = TokenUsageStatsSchema.extend({
  /** Response time in milliseconds */
  responseTimeMs: z.number().optional(),
  /** Tokens served from cache (reduces cost) */
  cachedInputTokens: z.number().optional(),
  /** Tokens written to cache (Anthropic only, increases cost by 1.25x) */
  cacheCreationTokens: z.number().optional(),
  /** Percentage of input tokens served from cache */
  percentageCached: z.number().optional(),
  /** Tokens used for reasoning (o1, DeepSeek-R1, Gemini thinking) */
  reasoningTokens: z.number().optional(),
  /** Tokens consumed by tool use prompts */
  toolUsePromptTokens: z.number().optional(),
  /** Number of server-side tool executions (Anthropic web search) */
  serverToolRequests: z.number().optional(),
});

export type PersistedUsageStats = z.infer<typeof PersistedUsageStatsSchema>;

/**
 * Converts ExtendedTokenUsageStats to PersistedUsageStats format.
 * Maps field names from the execution-time format to the persistence format.
 */
export function toPersistedUsageStats(
  stats: ExtendedTokenUsageStats,
): PersistedUsageStats {
  return {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cost: stats.cost,
    // Map elapsedTime (seconds) to responseTimeMs (milliseconds)
    responseTimeMs:
      stats.elapsedTime !== undefined
        ? Math.round(stats.elapsedTime * 1000)
        : undefined,
    cachedInputTokens: stats.cacheReadInputTokens,
    cacheCreationTokens: stats.cacheCreationInputTokens,
    percentageCached: stats.percentageCached,
    reasoningTokens: stats.reasoningTokens,
    toolUsePromptTokens: stats.toolUseTokens,
    // Note: serverToolRequests not available in ExtendedTokenUsageStats
  };
}

/**
 * Message interface for updating usage stats in the progress view.
 */
export const StreamUsageMessageSchema = z.strictObject({
  command: z.literal('updateUsage'),
  stream: z.string(),
  usageByRun: z.record(z.string(), TokenUsageStatsSchema).prefault({}),
});

export type StreamUsageMessage = z.infer<typeof StreamUsageMessageSchema>;
