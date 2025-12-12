/**
 * Token usage statistics for tracking model usage and costs.
 *
 * This module is part of the @types/ layer - the foundation that all other
 * layers can import from without creating circular dependencies.
 */
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
 * Message interface for updating usage stats in the progress view.
 */
export const StreamUsageMessageSchema = z.strictObject({
  command: z.literal('updateUsage'),
  stream: z.string(),
  usageByRun: z.record(z.string(), TokenUsageStatsSchema).prefault({}),
});

export type StreamUsageMessage = z.infer<typeof StreamUsageMessageSchema>;
