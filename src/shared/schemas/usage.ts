import { z } from 'zod';

import { ContextStateDataSchema } from './contextManagement';

export const TokenUsageStatsSchema = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
});

export type TokenUsageStats = z.infer<typeof TokenUsageStatsSchema>;

/**
 * Extended token usage with per-round deltas. Note: percentageCached is
 * calculated from accumulated session totals for overall caching effectiveness.
 */
export const ExtendedTokenUsageStatsSchema = TokenUsageStatsSchema.extend({
  elapsedTime: z.number().optional(),
  percentageCached: z.number().optional(),
  reasoningTokens: z.number().optional(),
  toolUseTokens: z.number().optional(),
});

export type ExtendedTokenUsageStats = z.infer<
  typeof ExtendedTokenUsageStatsSchema
>;

/**
 * Context state for tracking context utilization.
 * Re-exported from contextManagement.ts for backward compatibility.
 * Uses ContextStateDataSchema as the single source of truth.
 */
export const ContextStateSchema = ContextStateDataSchema;

export type ContextState = z.infer<typeof ContextStateSchema>;
