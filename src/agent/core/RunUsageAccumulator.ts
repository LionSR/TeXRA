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
  totalCacheCreationInputTokens: 0,
  totalReasoningTokens: 0,
  totalToolUsePromptTokens: 0,
  totalServerToolRequests: 0,
} as const;

/** Schema for run usage totals. Internal only. */
const RunUsageTotalsSchema = z.object({
  firstInputTokens: z.number().prefault(DEFAULT_TOTALS.firstInputTokens),
  totalInputTokens: z.number().prefault(DEFAULT_TOTALS.totalInputTokens),
  totalOutputTokens: z.number().prefault(DEFAULT_TOTALS.totalOutputTokens),
  totalCost: z.number().prefault(DEFAULT_TOTALS.totalCost),
  totalCacheReadInputTokens: z
    .number()
    .prefault(DEFAULT_TOTALS.totalCacheReadInputTokens),
  totalCacheCreationInputTokens: z
    .number()
    .prefault(DEFAULT_TOTALS.totalCacheCreationInputTokens),
  totalReasoningTokens: z
    .number()
    .prefault(DEFAULT_TOTALS.totalReasoningTokens),
  totalToolUsePromptTokens: z
    .number()
    .prefault(DEFAULT_TOTALS.totalToolUsePromptTokens),
  totalServerToolRequests: z
    .number()
    .prefault(DEFAULT_TOTALS.totalServerToolRequests),
});
export type RunUsageTotals = z.infer<typeof RunUsageTotalsSchema>;

/** Schema for normalized usage snapshot. Internal only. */
const NormalizedUsageSnapshotSchema = z.object({
  round: z.number(),
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

/** Create a fresh accumulator (all zeros). */
export function createUsageAccumulator(): RunUsageAccumulatorJSON {
  return { totals: { ...DEFAULT_TOTALS }, normalizedSnapshots: [] };
}

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
  acc.totals.totalCacheCreationInputTokens += usage.cacheCreationTokens ?? 0;
  acc.totals.totalReasoningTokens += usage.reasoningTokens ?? 0;
  acc.totals.totalToolUsePromptTokens += usage.toolUsePromptTokens ?? 0;
  acc.totals.totalServerToolRequests += usage.serverToolRequests ?? 0;

  acc.normalizedSnapshots.push({ round, usage });
}

/** Merge another accumulator's data into this one. Mutates target in place. */
export function mergeAccumulators(
  target: RunUsageAccumulatorJSON,
  source: RunUsageAccumulatorJSON,
): void {
  const src = source.totals;
  if (target.totals.firstInputTokens === 0) {
    target.totals.firstInputTokens = src.firstInputTokens;
  }

  target.totals.totalInputTokens += src.totalInputTokens;
  target.totals.totalOutputTokens += src.totalOutputTokens;
  target.totals.totalCost += src.totalCost;
  target.totals.totalCacheReadInputTokens += src.totalCacheReadInputTokens;
  target.totals.totalCacheCreationInputTokens +=
    src.totalCacheCreationInputTokens;
  target.totals.totalReasoningTokens += src.totalReasoningTokens;
  target.totals.totalToolUsePromptTokens += src.totalToolUsePromptTokens;
  target.totals.totalServerToolRequests += src.totalServerToolRequests;

  target.normalizedSnapshots.push(...source.normalizedSnapshots);
}
