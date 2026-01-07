// Third-party imports
import { z } from 'zod';

// Local imports - types
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';

/** Default values for run usage totals - exported for use in schema defaults */
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

/** Schema for run usage totals - uses .prefault() for input normalization */
export const RunUsageTotalsSchema = z.object({
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

/** Schema for normalized usage snapshot */
export const NormalizedUsageSnapshotSchema = z.object({
  round: z.number(),
  usage: NormalizedUsageSchema,
});
export type NormalizedUsageSnapshot = z.infer<
  typeof NormalizedUsageSnapshotSchema
>;

/**
 * Schema for RunUsageAccumulator JSON serialization.
 * Uses .prefault() for input normalization before validation.
 */
export const RunUsageAccumulatorJSONSchema = z.object({
  totals: RunUsageTotalsSchema.prefault(DEFAULT_TOTALS),
  normalizedSnapshots: z.array(NormalizedUsageSnapshotSchema).prefault([]),
  /** Baseline for delta computation - null means start of run */
  baselineTotals: RunUsageTotalsSchema.nullable().prefault(null),
});

/**
 * Output type for RunUsageAccumulator serialization.
 * Uses z.output<> to get the type after parsing (totals fully resolved).
 */
export type RunUsageAccumulatorJSON = z.output<
  typeof RunUsageAccumulatorJSONSchema
>;

export class RunUsageAccumulator {
  private totals: RunUsageTotals = { ...DEFAULT_TOTALS };
  private readonly normalizedSnapshots: NormalizedUsageSnapshot[] = [];
  /** Baseline totals for delta computation (null = start of run) */
  private _baselineTotals: RunUsageTotals | null = null;

  /** Deserialize from a snapshot. Schema transform handles default merging. */
  static fromSnapshot(snapshot: unknown): RunUsageAccumulator {
    const parsed = RunUsageAccumulatorJSONSchema.parse(snapshot);
    const acc = new RunUsageAccumulator();
    acc.totals = parsed.totals;
    acc.normalizedSnapshots.push(...parsed.normalizedSnapshots);
    acc._baselineTotals = parsed.baselineTotals;
    return acc;
  }

  /** Serialize to a snapshot. */
  toSnapshot(): RunUsageAccumulatorJSON {
    return {
      totals: this.totals,
      normalizedSnapshots: [...this.normalizedSnapshots],
      baselineTotals: this._baselineTotals,
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

  /**
   * Capture current totals as baseline for delta computation.
   * Called at the start of each workflow round to enable per-round reporting.
   */
  captureBaseline(): void {
    this._baselineTotals = { ...this.totals };
  }

  /**
   * Get usage delta since the last captured baseline.
   * Returns per-round values while preserving cumulative totals for safety checks.
   *
   * Note: Returns RunUsageTotals type for API compatibility, but values represent
   * deltas (current - baseline), not cumulative totals. Field names like
   * "totalInputTokens" contain per-round delta values in this context.
   */
  getDeltaSinceBaseline(): RunUsageTotals {
    const baseline = this._baselineTotals ?? DEFAULT_TOTALS;
    return {
      // Preserve firstInputTokens from actual first input (not delta)
      firstInputTokens: this.totals.firstInputTokens,
      totalInputTokens: this.totals.totalInputTokens - baseline.totalInputTokens,
      totalOutputTokens:
        this.totals.totalOutputTokens - baseline.totalOutputTokens,
      totalCost: this.totals.totalCost - baseline.totalCost,
      totalCacheReadInputTokens:
        this.totals.totalCacheReadInputTokens -
        baseline.totalCacheReadInputTokens,
      totalCacheCreationInputTokens:
        this.totals.totalCacheCreationInputTokens -
        baseline.totalCacheCreationInputTokens,
      totalReasoningTokens:
        this.totals.totalReasoningTokens - baseline.totalReasoningTokens,
      totalToolUsePromptTokens:
        this.totals.totalToolUsePromptTokens - baseline.totalToolUsePromptTokens,
      totalServerToolRequests:
        this.totals.totalServerToolRequests - baseline.totalServerToolRequests,
    };
  }
}
