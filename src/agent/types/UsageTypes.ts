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
 *
 * Field names are aligned with NormalizedUsage for consistency:
 * - cachedInputTokens (was cacheReadInputTokens)
 * - cacheCreationTokens (was cacheCreationInputTokens)
 * - responseTimeMs (was elapsedTime in seconds)
 * - toolUsePromptTokens (was toolUseTokens)
 */
export const ExtendedTokenUsageStatsSchema = TokenUsageStatsSchema.extend({
  /** Response time in milliseconds */
  responseTimeMs: z.number().optional(),
  /** Tokens served from cache (reduces cost) */
  cachedInputTokens: z.number().optional(),
  /** Tokens written to cache (increases cost by 1.25x for Anthropic) */
  cacheCreationTokens: z.number().optional(),
  /** Percentage of tokens served from cache */
  percentageCached: z.number().optional(),
  /** Tokens used for reasoning */
  reasoningTokens: z.number().optional(),
  /** Tokens consumed by tool use prompts */
  toolUsePromptTokens: z.number().optional(),
});

export type ExtendedTokenUsageStats = z.infer<
  typeof ExtendedTokenUsageStatsSchema
>;

/**
 * Usage statistics for display in the Progress View.
 * Derived from ExtendedTokenUsageStats, picking only display-relevant fields.
 */
export const DisplayUsageStatsSchema = ExtendedTokenUsageStatsSchema.pick({
  inputTokens: true,
  outputTokens: true,
  cost: true,
  cachedInputTokens: true,
  cacheCreationTokens: true,
  percentageCached: true,
  reasoningTokens: true,
});

export type DisplayUsageStats = z.infer<typeof DisplayUsageStatsSchema>;

/**
 * Message interface for updating usage stats in the progress view.
 */
export const StreamUsageMessageSchema = z.strictObject({
  command: z.literal('updateUsage'),
  stream: z.string(),
  usageByRun: z.record(z.string(), TokenUsageStatsSchema).prefault({}),
});

export type StreamUsageMessage = z.infer<typeof StreamUsageMessageSchema>;
