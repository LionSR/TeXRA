// Third-party imports
import { z } from 'zod';

// Local imports - types
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';

/**
 * Default values for run usage totals - exported for use in schema defaults.
 *
 * `totalCost` is the running sum of `NormalizedUsage.cost`, which is already
 * calculated per provider (including prompt-cache discounts or creation
 * premiums). No extra adjustments are applied here.
 */
export const DEFAULT_TOTALS = {
  firstInputTokens: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
  totalCacheReadInputTokens: 0,
  totalCacheMissInputTokens: 0,
  totalCacheCreationInputTokens: 0,
  totalReasoningTokens: 0,
  totalToolUsePromptTokens: 0,
  totalServerToolRequests: 0,
} as const;

const TokenCountSchema = z.int().nonnegative();

/** Schema for run usage totals. Internal only. */
const RunUsageTotalsSchema = z.object({
  firstInputTokens: TokenCountSchema.prefault(0),
  totalInputTokens: TokenCountSchema.prefault(0),
  totalOutputTokens: TokenCountSchema.prefault(0),
  totalCost: z.number().nonnegative().prefault(0),
  totalCacheReadInputTokens: TokenCountSchema.prefault(0),
  totalCacheMissInputTokens: TokenCountSchema.prefault(0),
  totalCacheCreationInputTokens: TokenCountSchema.prefault(0),
  totalReasoningTokens: TokenCountSchema.prefault(0),
  totalToolUsePromptTokens: TokenCountSchema.prefault(0),
  totalServerToolRequests: TokenCountSchema.prefault(0),
});
export type RunUsageTotals = z.infer<typeof RunUsageTotalsSchema>;

/** Schema for normalized usage snapshot. Internal only. */
const NormalizedUsageSnapshotSchema = z.object({
  round: z.int().nonnegative(),
  usage: NormalizedUsageSchema,
});

/**
 * Schema for RunUsageAccumulator JSON serialization.
 * Uses .prefault() for input normalization before validation.
 */
export const RunUsageAccumulatorJSONSchema = z.object({
  totals: RunUsageTotalsSchema.prefault(DEFAULT_TOTALS),
  normalizedSnapshots: z.array(NormalizedUsageSnapshotSchema).prefault([]),
});

/**
 * Output type for RunUsageAccumulator serialization.
 * Uses z.output<> to get the type after parsing (totals fully resolved).
 */
export type RunUsageAccumulatorJSON = z.output<
  typeof RunUsageAccumulatorJSONSchema
>;

// ============================================================================
// Standalone functions operating on RunUsageAccumulatorJSON
// ============================================================================

/** Record a normalized usage entry. Mutates acc in place. */
export function recordNormalizedUsage(
  acc: RunUsageAccumulatorJSON,
  round: number,
  usage: NormalizedUsage,
): void {
  if (acc.totals.firstInputTokens === 0) {
    acc.totals.firstInputTokens = usage.inputTokens;
  }

  acc.totals.totalInputTokens += usage.inputTokens;
  acc.totals.totalOutputTokens += usage.outputTokens;
  acc.totals.totalCost += usage.cost;
  acc.totals.totalCacheReadInputTokens += usage.cachedInputTokens ?? 0;
  acc.totals.totalCacheMissInputTokens += usage.cacheMissInputTokens ?? 0;
  acc.totals.totalCacheCreationInputTokens += usage.cacheCreationTokens ?? 0;
  acc.totals.totalReasoningTokens += usage.reasoningTokens ?? 0;
  acc.totals.totalToolUsePromptTokens += usage.toolUsePromptTokens ?? 0;
  acc.totals.totalServerToolRequests += usage.serverToolRequests ?? 0;

  acc.normalizedSnapshots.push({ round, usage });
}
