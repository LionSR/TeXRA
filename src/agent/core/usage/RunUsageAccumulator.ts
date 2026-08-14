// Third-party imports
import { z } from 'zod';

// Local imports
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';
import { TokenCountSchema } from '@shared/schemas';

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
 * Single source of truth mapping each accumulative {@link NormalizedUsage}
 * metric to the {@link RunUsageTotals} field it sums into. `RunUsageTotalsSchema`
 * deliberately stays explicit above — it documents the persisted wire shape —
 * but `recordNormalizedUsage` iterates this table, so adding a metric means
 * touching exactly two places (schema + one row here) and renaming a field on
 * either side fails the type check via `satisfies`.
 */
const TOTAL_ACCUMULATORS = [
  ['inputTokens', 'totalInputTokens'],
  ['outputTokens', 'totalOutputTokens'],
  ['cost', 'totalCost'],
  ['cachedInputTokens', 'totalCacheReadInputTokens'],
  ['cacheMissInputTokens', 'totalCacheMissInputTokens'],
  ['cacheCreationTokens', 'totalCacheCreationInputTokens'],
  ['reasoningTokens', 'totalReasoningTokens'],
  ['toolUsePromptTokens', 'totalToolUsePromptTokens'],
  ['serverToolRequests', 'totalServerToolRequests'],
] as const satisfies ReadonlyArray<
  readonly [usageField: keyof NormalizedUsage, totalField: keyof RunUsageTotals]
>;

/**
 * Schema for RunUsageAccumulator JSON serialization.
 *
 * `latestUsage` replaces the old unbounded `normalizedSnapshots` array;
 * only the most-recent round's usage is needed at runtime. The legacy
 * `normalizedSnapshots` format is retired: strict parsing rejects a blob
 * still carrying that key, so stale resume data fails loudly through the
 * existing resume-parse failure path instead of silently dropping usage.
 */
export const RunUsageAccumulatorJSONSchema = z.strictObject({
  totals: RunUsageTotalsSchema.prefault({}),
  latestUsage: NormalizedUsageSchema.nullable().prefault(null),
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
  usage: NormalizedUsage,
): void {
  if (acc.totals.firstInputTokens === 0) {
    acc.totals.firstInputTokens = usage.inputTokens;
  }

  for (const [usageField, totalField] of TOTAL_ACCUMULATORS) {
    acc.totals[totalField] += usage[usageField] ?? 0;
  }

  acc.latestUsage = usage;
}
