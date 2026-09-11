// Third-party imports
import { z } from 'zod';

// Local imports
import {
  RunUsageTotalsSchema,
  type NormalizedUsage,
  type RunUsageAccumulatorJSON,
} from '@shared/schemas';

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
