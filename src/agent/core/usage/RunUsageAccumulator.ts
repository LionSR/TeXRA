// Third-party imports
import { z } from 'zod';

// Local imports
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';
import * as logger from '@logger/logUtils';
import { TokenCountSchema } from '@shared/schemas';

const CHANNEL = 'RunUsageAccumulator';

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
 * Canonical schema for RunUsageAccumulator JSON serialization.
 *
 * `latestUsage` replaces the old unbounded `normalizedSnapshots` array;
 * only the most-recent round's usage is needed at runtime.
 */
const RunUsageAccumulatorCanonicalSchema = z.object({
  totals: RunUsageTotalsSchema.prefault({}),
  latestUsage: NormalizedUsageSchema.nullable().prefault(null),
});

/**
 * Output type for RunUsageAccumulator serialization.
 * Uses z.output<> to get the type after parsing (totals fully resolved).
 */
export type RunUsageAccumulatorJSON = z.output<
  typeof RunUsageAccumulatorCanonicalSchema
>;

/**
 * Legacy persisted format: an unbounded `normalizedSnapshots` array instead of
 * `latestUsage`. Only the most-recent snapshot's usage is needed, so the array
 * is collapsed to its last element and the rest discarded. This arm requires
 * `normalizedSnapshots`, so it only matches genuinely-legacy data; canonical
 * and empty inputs fall through to the canonical schema below. Hybrid payloads
 * that carry both keys keep their canonical `latestUsage` (see the transform).
 *
 * Each snapshot is parsed tolerantly (`.catch`): the old preprocess only ever
 * read the last element's `usage`, so a malformed earlier snapshot must not
 * fail the whole arm (which would drop the latest valid usage on resume). A
 * malformed `usage` degrades to `null` rather than rejecting the payload, but
 * the degradation is logged so a corrupted legacy record doesn't vanish
 * silently.
 */
const LegacyRunUsageAccumulatorSchema = z
  .object({
    totals: RunUsageTotalsSchema.prefault({}),
    latestUsage: NormalizedUsageSchema.nullish(),
    normalizedSnapshots: z.array(
      z.object({ usage: NormalizedUsageSchema.nullish() }).catch((ctx) => {
        logger.warn(
          CHANNEL,
          'Malformed legacy normalizedSnapshots entry, discarding its usage',
          { data: ctx.issues },
        );
        return { usage: null };
      }),
    ),
  })
  .transform((legacy): RunUsageAccumulatorJSON => ({
    totals: legacy.totals,
    // Key-presence, not value-nullish: a hybrid payload carrying both an
    // explicit `latestUsage` (even `null`, an already-migrated state) and
    // snapshots must keep the canonical value. `.nullish()` parses an absent
    // key as `undefined` and an explicit `null` as `null`, so `!== undefined`
    // keeps an explicit null and only an absent key falls back to the latest
    // snapshot. Matches the prior `'latestUsage' in raw` preprocess guard.
    latestUsage:
      legacy.latestUsage !== undefined
        ? legacy.latestUsage
        : (legacy.normalizedSnapshots.at(-1)?.usage ?? null),
  }));

/**
 * Entry schema handling both formats in one place (per the backward-compat
 * convention in CLAUDE.md). The legacy arm is tried first because it requires
 * `normalizedSnapshots`; canonical and empty payloads only match the second
 * arm, so all downstream code sees one canonical shape.
 */
export const RunUsageAccumulatorJSONSchema = z.union([
  LegacyRunUsageAccumulatorSchema,
  RunUsageAccumulatorCanonicalSchema,
]);

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
