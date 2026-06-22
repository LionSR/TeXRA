// Third-party imports
import { z } from 'zod';

// Local imports - types
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';

const TokenCountSchema = z.int().nonnegative();

/**
 * Schema for run usage totals. Internal only.
 *
 * `totalCost` is the running sum of `NormalizedUsage.cost`, which is already
 * calculated per provider (including prompt-cache discounts or creation
 * premiums). No extra adjustments are applied here.
 */
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

/**
 * Schema for RunUsageAccumulator JSON serialization.
 * Uses .prefault() for input normalization before validation.
 *
 * `latestUsage` replaces the old unbounded `normalizedSnapshots` array —
 * only the most-recent round's usage is needed at runtime. The preprocess
 * migrates legacy persisted data (with `normalizedSnapshots`) by extracting
 * the last element, so existing sessions resume without data loss.
 */
export const RunUsageAccumulatorJSONSchema = z.preprocess(
  (raw) => {
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      !('latestUsage' in raw) &&
      'normalizedSnapshots' in raw &&
      Array.isArray((raw as Record<string, unknown>).normalizedSnapshots)
    ) {
      const snapshots = (raw as Record<string, unknown>)
        .normalizedSnapshots as unknown[];
      const last = snapshots.at(-1);
      const usage =
        last &&
        typeof last === 'object' &&
        !Array.isArray(last) &&
        'usage' in (last as Record<string, unknown>)
          ? (last as Record<string, unknown>).usage
          : null;
      return {
        ...(raw as Record<string, unknown>),
        latestUsage: usage ?? null,
      };
    }
    return raw;
  },
  z.object({
    totals: RunUsageTotalsSchema.prefault({}),
    latestUsage: NormalizedUsageSchema.nullable().prefault(null),
  }),
);

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

  acc.latestUsage = usage;
}
