// Local imports - agent components
import type {
  OpenAIAPIResponseUsage,
  AnthropicAPIResponseUsage,
} from '@agent/core/ResponseUsage';

export type ProviderUsageMetrics =
  | OpenAIAPIResponseUsage
  | AnthropicAPIResponseUsage;

export interface RoundMetricsSnapshot {
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  toolUseTokens: number;
  percentageCached: number;
  cost: number;
}

function toRoundMetricsSnapshot(
  usage: ProviderUsageMetrics,
): RoundMetricsSnapshot {
  const cacheRead =
    'cache_read_input_tokens' in usage && usage.cache_read_input_tokens
      ? usage.cache_read_input_tokens
      : 0;
  const cacheCreation =
    'cache_creation_input_tokens' in usage && usage.cache_creation_input_tokens
      ? usage.cache_creation_input_tokens
      : 0;
  const cachedPrompt =
    'cached_tokens' in usage && typeof usage.cached_tokens === 'number'
      ? usage.cached_tokens
      : 0;
  const reasoningTokens =
    'reasoning_tokens' in usage && typeof usage.reasoning_tokens === 'number'
      ? usage.reasoning_tokens
      : 0;
  const toolUseTokens =
    'tool_use_tokens' in usage && usage.tool_use_tokens
      ? usage.tool_use_tokens
      : 0;

  return {
    totalInputTokens: usage.totalInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    cachedPromptTokens: cachedPrompt,
    reasoningTokens,
    toolUseTokens,
    percentageCached: usage.percentageCached,
    cost: usage.cost,
  };
}

export interface RoundMetricsObject {
  roundIndex: number;
  continuationCount: number;
  responseTime: number;
  metrics: RoundMetricsSnapshot | null;
}

/**
 * Tracks per-round metrics while keeping them separate from run-level
 * aggregations. Only aggregate data is stored so downstream consumers do not
 * depend on provider-specific usage payloads.
 */
export class RoundMetricsState {
  readonly roundIndex: number;
  continuationCount = 0;
  private responseTimeMs = 0;
  private metrics: RoundMetricsSnapshot | null = null;

  constructor(roundIndex: number) {
    this.roundIndex = roundIndex;
  }

  updateFromUsage(usage: ProviderUsageMetrics): void {
    this.metrics = toRoundMetricsSnapshot(usage);
  }

  updateResponseTime(responseTime: number): void {
    this.responseTimeMs += responseTime;
  }

  incrementContinuation(): void {
    this.continuationCount += 1;
  }

  get responseTime(): number {
    return this.responseTimeMs;
  }

  getSnapshot(): RoundMetricsSnapshot | null {
    return this.metrics ? { ...this.metrics } : null;
  }

  toObject(): RoundMetricsObject {
    return {
      roundIndex: this.roundIndex,
      continuationCount: this.continuationCount,
      responseTime: this.responseTimeMs,
      metrics: this.getSnapshot(),
    };
  }

  static fromObject(obj: Partial<RoundMetricsObject>): RoundMetricsState {
    const state = new RoundMetricsState(obj.roundIndex ?? 0);
    state.continuationCount = obj.continuationCount ?? 0;
    state.responseTimeMs = obj.responseTime ?? 0;
    state.metrics = obj.metrics ?? null;
    return state;
  }
}

export interface RunMetricsObject {
  firstInputTokens: number;
  totalResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRounds: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCachedPromptTokens: number;
  totalReasoningTokens: number;
  totalToolUseTokens: number;
  totalCost: number;
}

/**
 * Aggregates metrics across all rounds in a run. The aggregation operates on
 * distilled round snapshots so the global state never needs raw API payloads.
 */
export class RunMetricsState {
  firstInputTokens = 0;
  totalResponseTime = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalRounds = 0;
  totalCacheReadInputTokens = 0;
  totalCacheCreationInputTokens = 0;
  totalCachedPromptTokens = 0;
  totalReasoningTokens = 0;
  totalToolUseTokens = 0;
  totalCost = 0;

  updateFromRound(round: RoundMetricsState): void {
    const snapshot = round.getSnapshot();
    if (!snapshot) {
      this.totalResponseTime += round.responseTime;
      return;
    }

    if (this.totalRounds === 0 && this.firstInputTokens === 0) {
      this.firstInputTokens =
        snapshot.totalInputTokens +
        snapshot.cacheReadInputTokens +
        snapshot.cacheCreationInputTokens;
    }

    this.totalInputTokens += snapshot.totalInputTokens;
    this.totalOutputTokens += snapshot.totalOutputTokens;
    this.totalCacheReadInputTokens +=
      snapshot.cacheReadInputTokens + snapshot.cachedPromptTokens;
    this.totalCacheCreationInputTokens += snapshot.cacheCreationInputTokens;
    this.totalCachedPromptTokens += snapshot.cachedPromptTokens;
    this.totalReasoningTokens += snapshot.reasoningTokens;
    this.totalToolUseTokens += snapshot.toolUseTokens;
    this.totalCost += snapshot.cost;
    this.totalResponseTime += round.responseTime;
  }

  incrementRounds(): void {
    this.totalRounds += 1;
  }

  toObject(): RunMetricsObject {
    return {
      firstInputTokens: this.firstInputTokens,
      totalResponseTime: this.totalResponseTime,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalRounds: this.totalRounds,
      totalCacheReadInputTokens: this.totalCacheReadInputTokens,
      totalCacheCreationInputTokens: this.totalCacheCreationInputTokens,
      totalCachedPromptTokens: this.totalCachedPromptTokens,
      totalReasoningTokens: this.totalReasoningTokens,
      totalToolUseTokens: this.totalToolUseTokens,
      totalCost: this.totalCost,
    };
  }

  static fromObject(obj: Partial<RunMetricsObject> | null): RunMetricsState {
    const state = new RunMetricsState();
    if (!obj) {
      return state;
    }

    state.firstInputTokens = obj.firstInputTokens ?? 0;
    state.totalResponseTime = obj.totalResponseTime ?? 0;
    state.totalInputTokens = obj.totalInputTokens ?? 0;
    state.totalOutputTokens = obj.totalOutputTokens ?? 0;
    state.totalRounds = obj.totalRounds ?? 0;
    state.totalCacheReadInputTokens = obj.totalCacheReadInputTokens ?? 0;
    state.totalCacheCreationInputTokens = obj.totalCacheCreationInputTokens ?? 0;
    state.totalCachedPromptTokens = obj.totalCachedPromptTokens ?? 0;
    state.totalReasoningTokens = obj.totalReasoningTokens ?? 0;
    state.totalToolUseTokens = obj.totalToolUseTokens ?? 0;
    state.totalCost = obj.totalCost ?? 0;
    return state;
  }
}
