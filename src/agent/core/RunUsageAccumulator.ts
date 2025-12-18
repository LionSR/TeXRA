// Third-party imports
import { z } from 'zod';

// Local imports - types
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';

/** Default values for run usage totals */
const DEFAULT_TOTALS = {
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

/** Schema for run usage totals with defaults */
export const RunUsageTotalsSchema = z.object({
  firstInputTokens: z.number().default(DEFAULT_TOTALS.firstInputTokens),
  totalInputTokens: z.number().default(DEFAULT_TOTALS.totalInputTokens),
  totalOutputTokens: z.number().default(DEFAULT_TOTALS.totalOutputTokens),
  totalCost: z.number().default(DEFAULT_TOTALS.totalCost),
  totalCacheReadInputTokens: z
    .number()
    .default(DEFAULT_TOTALS.totalCacheReadInputTokens),
  totalCacheCreationInputTokens: z
    .number()
    .default(DEFAULT_TOTALS.totalCacheCreationInputTokens),
  totalReasoningTokens: z.number().default(DEFAULT_TOTALS.totalReasoningTokens),
  totalToolUsePromptTokens: z
    .number()
    .default(DEFAULT_TOTALS.totalToolUsePromptTokens),
  totalServerToolRequests: z
    .number()
    .default(DEFAULT_TOTALS.totalServerToolRequests),
});
export type RunUsageTotals = z.infer<typeof RunUsageTotalsSchema>;

/** Schema for normalized usage snapshot */
export const NormalizedUsageSnapshotSchema = z.object({
  round: z.number(),
  usage: NormalizedUsageSchema,
});
export type NormalizedUsageSnapshot = z.infer<
  typeof NormalizedUsageSnapshotSchema
>;

/** Schema for RunUsageAccumulator JSON serialization (input accepts partial totals) */
export const RunUsageAccumulatorJSONSchema = z.object({
  totals: RunUsageTotalsSchema.partial().default({}),
  normalizedSnapshots: z.array(NormalizedUsageSnapshotSchema).default([]),
});
/**
 * Output type for RunUsageAccumulator serialization.
 * Uses z.output<> to get the type after parsing (all fields required).
 */
export type RunUsageAccumulatorJSON = z.output<
  typeof RunUsageAccumulatorJSONSchema
>;

export class RunUsageAccumulator {
  private totals: RunUsageTotals = { ...DEFAULT_TOTALS };
  private readonly normalizedSnapshots: NormalizedUsageSnapshot[] = [];

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): RunUsageAccumulator {
    const parsed = RunUsageAccumulatorJSONSchema.parse(snapshot);
    const acc = new RunUsageAccumulator();
    // .partial().default({}) returns {} for missing totals, NOT the field defaults.
    // Field-level defaults only apply when the field key is missing from a non-partial object.
    // We need to spread DEFAULT_TOTALS to fill in any missing fields.
    acc.totals = { ...DEFAULT_TOTALS, ...parsed.totals };
    acc.normalizedSnapshots.push(...parsed.normalizedSnapshots);
    return acc;
  }

  /** Serialize to a snapshot. */
  toSnapshot(): RunUsageAccumulatorJSON {
    return {
      totals: this.totals,
      normalizedSnapshots: [...this.normalizedSnapshots],
    };
  }

  recordNormalizedUsage(round: number, usage: NormalizedUsage): void {
    if (this.totals.firstInputTokens === 0) {
      this.totals.firstInputTokens =
        usage.inputTokens +
        (usage.cachedInputTokens ?? 0) +
        (usage.cacheCreationTokens ?? 0);
    }

    this.totals.totalInputTokens += usage.inputTokens;
    this.totals.totalOutputTokens += usage.outputTokens;
    this.totals.totalCost += usage.cost;
    this.totals.totalCacheReadInputTokens += usage.cachedInputTokens ?? 0;
    this.totals.totalCacheCreationInputTokens += usage.cacheCreationTokens ?? 0;
    this.totals.totalReasoningTokens += usage.reasoningTokens ?? 0;
    this.totals.totalToolUsePromptTokens += usage.toolUsePromptTokens ?? 0;
    this.totals.totalServerToolRequests += usage.serverToolRequests ?? 0;

    this.normalizedSnapshots.push({ round, usage });
  }

  merge(other: RunUsageAccumulator): void {
    const otherTotals = other.totals;
    if (this.totals.firstInputTokens === 0) {
      this.totals.firstInputTokens = otherTotals.firstInputTokens;
    }

    this.totals.totalInputTokens += otherTotals.totalInputTokens;
    this.totals.totalOutputTokens += otherTotals.totalOutputTokens;
    this.totals.totalCost += otherTotals.totalCost;
    this.totals.totalCacheReadInputTokens +=
      otherTotals.totalCacheReadInputTokens;
    this.totals.totalCacheCreationInputTokens +=
      otherTotals.totalCacheCreationInputTokens;
    this.totals.totalReasoningTokens += otherTotals.totalReasoningTokens;
    this.totals.totalToolUsePromptTokens +=
      otherTotals.totalToolUsePromptTokens;
    this.totals.totalServerToolRequests += otherTotals.totalServerToolRequests;

    this.normalizedSnapshots.push(...other.normalizedSnapshots);
  }

  getTotals(): RunUsageTotals {
    return this.totals;
  }

  getNormalizedSnapshots(): readonly NormalizedUsageSnapshot[] {
    return this.normalizedSnapshots;
  }
}
