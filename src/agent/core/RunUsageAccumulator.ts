// Third-party imports
import { z } from 'zod';

// Local imports - types
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';

/** Schema for run usage totals */
export const RunUsageTotalsSchema = z.object({
  firstInputTokens: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCost: z.number(),
  totalCacheReadInputTokens: z.number(),
  totalCacheCreationInputTokens: z.number(),
  totalReasoningTokens: z.number(),
  totalToolUsePromptTokens: z.number(),
  totalServerToolRequests: z.number(),
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

/** Schema for RunUsageAccumulator JSON serialization */
export const RunUsageAccumulatorJSONSchema = z.object({
  totals: RunUsageTotalsSchema.partial(),
  normalizedSnapshots: z.array(NormalizedUsageSnapshotSchema).optional(),
});
export type RunUsageAccumulatorJSON = z.infer<
  typeof RunUsageAccumulatorJSONSchema
>;

const DEFAULT_TOTALS: RunUsageTotals = {
  firstInputTokens: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
  totalCacheReadInputTokens: 0,
  totalCacheCreationInputTokens: 0,
  totalReasoningTokens: 0,
  totalToolUsePromptTokens: 0,
  totalServerToolRequests: 0,
};

export class RunUsageAccumulator {
  private totals: RunUsageTotals = { ...DEFAULT_TOTALS };
  private readonly normalizedSnapshots: NormalizedUsageSnapshot[] = [];

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

  toJSON(): RunUsageAccumulatorJSON {
    return {
      totals: this.totals,
      normalizedSnapshots:
        this.normalizedSnapshots.length > 0
          ? this.normalizedSnapshots
          : undefined,
    };
  }

  static fromJSON(
    json: RunUsageAccumulatorJSON | null | undefined,
  ): RunUsageAccumulator {
    const acc = new RunUsageAccumulator();
    if (!json) return acc;

    const t = json.totals;
    acc.totals = {
      firstInputTokens: t.firstInputTokens ?? 0,
      totalInputTokens: t.totalInputTokens ?? 0,
      totalOutputTokens: t.totalOutputTokens ?? 0,
      totalCost: t.totalCost ?? 0,
      totalCacheReadInputTokens: t.totalCacheReadInputTokens ?? 0,
      totalCacheCreationInputTokens: t.totalCacheCreationInputTokens ?? 0,
      totalReasoningTokens: t.totalReasoningTokens ?? 0,
      totalToolUsePromptTokens: t.totalToolUsePromptTokens ?? 0,
      totalServerToolRequests: t.totalServerToolRequests ?? 0,
    };

    if (json.normalizedSnapshots) {
      acc.normalizedSnapshots.push(...json.normalizedSnapshots);
    }

    return acc;
  }
}
