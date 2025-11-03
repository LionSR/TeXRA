// Local imports - response usage types
import type {
  AnthropicAPIResponseUsage,
  OpenAIAPIResponseUsage,
  ExtendedCompletionUsage,
  AnthropicUsage,
  GenerateContentResponseUsageMetadata,
} from './ResponseUsage';

export type NativeUsagePayload =
  | ExtendedCompletionUsage
  | AnthropicUsage
  | GenerateContentResponseUsageMetadata;

export type UsageSummary =
  | OpenAIAPIResponseUsage
  | AnthropicAPIResponseUsage
  | null;

export type UsageProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'unknown';

export interface NativeUsageSnapshot {
  round: number;
  provider: UsageProvider;
  payload: NativeUsagePayload;
}

export interface RunUsageTotals {
  firstInputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalReasoningTokens: number;
  totalToolUseTokens: number;
}

export interface RunUsageAccumulatorJSON {
  totals: RunUsageTotals;
  snapshots: NativeUsageSnapshot[];
}

export class RunUsageAccumulator {
  private totals: RunUsageTotals = {
    firstInputTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadInputTokens: 0,
    totalCacheCreationInputTokens: 0,
    totalReasoningTokens: 0,
    totalToolUseTokens: 0,
  };

  private readonly snapshots: NativeUsageSnapshot[] = [];

  recordRoundUsage(params: {
    round: number;
    provider: UsageProvider;
    summary: UsageSummary;
    nativeUsage?: NativeUsagePayload | null;
  }): void {
    const { round, provider, summary, nativeUsage } = params;

    if (summary) {
      if (this.totals.firstInputTokens === 0) {
        this.totals.firstInputTokens = summary.totalInputTokens;
      }

      this.totals.totalInputTokens += summary.totalInputTokens;
      this.totals.totalOutputTokens += summary.totalOutputTokens;

      if ('cache_read_input_tokens' in summary) {
        const cacheRead = summary.cache_read_input_tokens ?? 0;
        const cacheCreation = summary.cache_creation_input_tokens ?? 0;
        this.totals.totalCacheReadInputTokens += cacheRead;
        this.totals.totalCacheCreationInputTokens += cacheCreation;
        this.totals.firstInputTokens += cacheRead + cacheCreation;

        const toolUseTokens = (summary as any).tool_use_tokens as
          | number
          | undefined;
        if (typeof toolUseTokens === 'number') {
          this.totals.totalToolUseTokens += toolUseTokens;
        }
      } else if ('prompt_tokens' in summary) {
        const promptDetails = summary.prompt_tokens_details;
        const cachedTokens = (promptDetails?.cached_tokens ?? 0) as number;
        this.totals.totalCacheReadInputTokens += cachedTokens;

        const completionDetails = summary.completion_tokens_details as
          | { reasoning_tokens?: number }
          | undefined;
        const reasoningTokens =
          completionDetails?.reasoning_tokens ??
          ((summary as any).reasoning_tokens as number | undefined) ??
          0;
        if (reasoningTokens) {
          this.totals.totalReasoningTokens += reasoningTokens;
        }

        const toolUseTokens = (summary as any).tool_use_tokens as
          | number
          | undefined;
        if (typeof toolUseTokens === 'number') {
          this.totals.totalToolUseTokens += toolUseTokens;
        }
      }
    }

    if (nativeUsage) {
      this.snapshots.push({
        round,
        provider,
        payload: nativeUsage,
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
    this.totals.totalCacheReadInputTokens +=
      otherTotals.totalCacheReadInputTokens;
    this.totals.totalCacheCreationInputTokens +=
      otherTotals.totalCacheCreationInputTokens;
    this.totals.totalReasoningTokens += otherTotals.totalReasoningTokens;
    this.totals.totalToolUseTokens += otherTotals.totalToolUseTokens;

    for (const snapshot of accumulator.getNativeUsageSnapshots()) {
      this.snapshots.push(snapshot);
    }
  }

  getTotals(): RunUsageTotals {
    return { ...this.totals };
  }

  getNativeUsageSnapshots(): NativeUsageSnapshot[] {
    return [...this.snapshots];
  }

  toJSON(): RunUsageAccumulatorJSON {
    return {
      totals: this.getTotals(),
      snapshots: this.getNativeUsageSnapshots(),
    };
  }

  static fromJSON(
    json: RunUsageAccumulatorJSON | null | undefined,
  ): RunUsageAccumulator {
    const accumulator = new RunUsageAccumulator();
    if (!json) {
      return accumulator;
    }

    accumulator.totals = { ...json.totals };
    accumulator.snapshots.push(...json.snapshots);
    return accumulator;
  }
}
