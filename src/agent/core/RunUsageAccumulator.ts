// Local imports - types
import type { NormalizedUsage, UsageProvider } from '@agent/types/NormalizedUsage';

// Re-export for backwards compatibility
import type {
  AnthropicAPIResponseUsage,
  OpenAIAPIResponseUsage,
  NativeUsagePayload,
} from './ResponseUsage';

export type { NativeUsagePayload };

// Re-export UsageProvider for backward compatibility
export type { UsageProvider };

/**
 * @deprecated Use NormalizedUsage instead
 */
export type UsageSummary =
  | OpenAIAPIResponseUsage
  | AnthropicAPIResponseUsage
  | null;

/**
 * @deprecated Use UsageProvider from NormalizedUsage instead
 */
export type LegacyUsageProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'unknown';

/**
 * @deprecated Use NormalizedUsage[] instead
 */
export interface NativeUsageSnapshot {
  round: number;
  provider: LegacyUsageProvider;
  payload: NativeUsagePayload;
}

/**
 * Snapshot of normalized usage for a single round.
 */
export interface NormalizedUsageSnapshot {
  round: number;
  usage: NormalizedUsage;
}

export interface RunUsageTotals {
  firstInputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalReasoningTokens: number;
  totalToolUseTokens: number;
}

export interface RunUsageAccumulatorJSON {
  totals: RunUsageTotals;
  /** @deprecated Use normalizedSnapshots instead */
  snapshots?: NativeUsageSnapshot[];
  normalizedSnapshots?: NormalizedUsageSnapshot[];
}

export class RunUsageAccumulator {
  private totals: RunUsageTotals = {
    firstInputTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    totalCacheReadInputTokens: 0,
    totalCacheCreationInputTokens: 0,
    totalReasoningTokens: 0,
    totalToolUseTokens: 0,
  };

  private readonly normalizedSnapshots: NormalizedUsageSnapshot[] = [];

  /**
   * Records normalized usage from a model response.
   * This is the preferred method - cost is already computed in the usage.
   */
  recordNormalizedUsage(round: number, usage: NormalizedUsage): void {
    // Track first round's input tokens
    if (this.totals.firstInputTokens === 0) {
      this.totals.firstInputTokens = usage.inputTokens;
    }

    // Accumulate core metrics
    this.totals.totalInputTokens += usage.inputTokens;
    this.totals.totalOutputTokens += usage.outputTokens;
    this.totals.totalCost += usage.cost;

    // Accumulate optional metrics
    if (usage.cachedInputTokens) {
      this.totals.totalCacheReadInputTokens += usage.cachedInputTokens;
    }
    if (usage.cacheCreationTokens) {
      this.totals.totalCacheCreationInputTokens += usage.cacheCreationTokens;
    }
    if (usage.reasoningTokens) {
      this.totals.totalReasoningTokens += usage.reasoningTokens;
    }
    if (usage.toolUseTokens) {
      this.totals.totalToolUseTokens += usage.toolUseTokens;
    }

    // Store snapshot
    this.normalizedSnapshots.push({ round, usage });
  }

  /**
   * @deprecated Use recordNormalizedUsage() instead.
   * Records usage from provider-specific types (legacy method).
   */
  recordRoundUsage(params: {
    round: number;
    provider: UsageProvider;
    summary: UsageSummary;
    nativeUsage?: NativeUsagePayload | null;
  }): void {
    const { summary } = params;

    if (summary) {
      if (this.totals.firstInputTokens === 0) {
        this.totals.firstInputTokens = summary.totalInputTokens;
      }

      this.totals.totalInputTokens += summary.totalInputTokens;
      this.totals.totalOutputTokens += summary.totalOutputTokens;
      this.totals.totalCost += summary.cost;

      if ('cache_read_input_tokens' in summary) {
        const cacheRead = summary.cache_read_input_tokens ?? 0;
        const cacheCreation = summary.cache_creation_input_tokens ?? 0;
        this.totals.totalCacheReadInputTokens += cacheRead;
        this.totals.totalCacheCreationInputTokens += cacheCreation;

        const toolUseTokens = summary.tool_use_tokens ?? 0;
        if (toolUseTokens) {
          this.totals.totalToolUseTokens += toolUseTokens;
        }
      } else if ('prompt_tokens' in summary) {
        const promptDetails = summary.prompt_tokens_details;
        const cachedTokens = promptDetails?.cached_tokens ?? 0;
        this.totals.totalCacheReadInputTokens += cachedTokens;

        const reasoningTokens =
          summary.completion_tokens_details?.reasoning_tokens ??
          summary.reasoning_tokens ??
          0;
        if (reasoningTokens) {
          this.totals.totalReasoningTokens += reasoningTokens;
        }

        const toolUseTokens = summary.tool_use_tokens ?? 0;
        if (toolUseTokens) {
          this.totals.totalToolUseTokens += toolUseTokens;
        }
      }
    }

    // Convert to normalized format if we have summary
    if (summary) {
      this.normalizedSnapshots.push({
        round: params.round,
        usage: {
          inputTokens: summary.totalInputTokens,
          outputTokens: summary.totalOutputTokens,
          cost: summary.cost,
          responseTimeMs: summary.responseTime,
          provider: params.provider,
          _native: params.nativeUsage ?? undefined,
        },
      });
    }
  }

  merge(accumulator: RunUsageAccumulator): void {
    const otherTotals = accumulator.getTotals();
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
    this.totals.totalToolUseTokens += otherTotals.totalToolUseTokens;

    for (const snapshot of accumulator.getNormalizedSnapshots()) {
      this.normalizedSnapshots.push(snapshot);
    }
  }

  getTotals(): RunUsageTotals {
    return { ...this.totals };
  }

  /**
   * Returns normalized usage snapshots.
   */
  getNormalizedSnapshots(): NormalizedUsageSnapshot[] {
    return [...this.normalizedSnapshots];
  }

  /**
   * @deprecated Use getNormalizedSnapshots() instead.
   * Returns legacy native usage snapshots for backward compatibility.
   */
  getNativeUsageSnapshots(): NativeUsageSnapshot[] {
    return this.normalizedSnapshots.map((snap) => ({
      round: snap.round,
      provider: snap.usage.provider as LegacyUsageProvider,
      payload: snap.usage._native as NativeUsagePayload,
    }));
  }

  toJSON(): RunUsageAccumulatorJSON {
    return {
      totals: this.getTotals(),
      normalizedSnapshots: this.getNormalizedSnapshots(),
    };
  }

  static fromJSON(
    json: RunUsageAccumulatorJSON | null | undefined,
  ): RunUsageAccumulator {
    const accumulator = new RunUsageAccumulator();
    if (!json) {
      return accumulator;
    }

    Object.assign(accumulator.totals, json.totals);

    // Load normalized snapshots if available
    if (json.normalizedSnapshots) {
      accumulator.normalizedSnapshots.push(...json.normalizedSnapshots);
    }

    return accumulator;
  }
}
