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

  /** @internal Used by codec - prefer RunUsageAccumulatorCodec.encode() */
  _setTotals(totals: RunUsageTotals): void {
    this.totals = totals;
  }

  /** @internal Used by codec - prefer RunUsageAccumulatorCodec.decode() */
  _pushSnapshots(snapshots: NormalizedUsageSnapshot[]): void {
    this.normalizedSnapshots.push(...snapshots);
  }
}

/**
 * Codec for bi-directional serialization of RunUsageAccumulator.
 * Use .encode() to serialize and .decode() to deserialize.
 */
export const RunUsageAccumulatorCodec = z.codec(
  RunUsageAccumulatorJSONSchema,
  z.instanceof(RunUsageAccumulator),
  {
    // Note: z.codec() does NOT auto-validate input before calling decode.
    // We parse to apply schema defaults for legacy snapshots missing fields.
    decode: (json): RunUsageAccumulator => {
      const parsed = RunUsageAccumulatorJSONSchema.parse(json);
      const acc = new RunUsageAccumulator();
      const totals = RunUsageTotalsSchema.parse(parsed.totals);
      acc._setTotals(totals);
      acc._pushSnapshots(parsed.normalizedSnapshots);
      return acc;
    },
    encode: (acc: RunUsageAccumulator): RunUsageAccumulatorJSON => ({
      totals: acc.getTotals(),
      normalizedSnapshots: [...acc.getNormalizedSnapshots()],
    }),
  },
);
