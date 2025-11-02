// Local imports - agent components
import {
  OpenAIAPIResponseUsage,
  AnthropicAPIResponseUsage,
} from './ResponseUsage';

// Local imports - logging
import * as logger from '@logger/logUtils';

const CHANNEL = 'Agent';
logger.initialize(CHANNEL);

/** Snapshot of usage metrics that a single round contributes to a run. */
export interface RoundUsageMetricsSnapshot {
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  toolUseTokens: number;
  firstInputTokenContribution: number;
}

/** Interface for tracking state within a single conversation round. */
export interface IRoundMetricsState {
  currRound: number;
  continuationCount: number;
  responseTime: number;
  metrics: RoundUsageMetricsSnapshot | null;
}

function createEmptyMetrics(): RoundUsageMetricsSnapshot {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    toolUseTokens: 0,
    firstInputTokenContribution: 0,
  };
}

/** Manages state and metrics for a single conversation round. */
export class RoundMetricsState implements IRoundMetricsState {
  currRound: number;
  continuationCount: number;
  responseTime: number;
  private usageMetrics: RoundUsageMetricsSnapshot;
  private hasUsageMetrics: boolean;

  constructor(currRound: number) {
    this.currRound = currRound;
    this.continuationCount = 0;
    this.responseTime = 0;
    this.usageMetrics = createEmptyMetrics();
    this.hasUsageMetrics = false;
  }

  /** Updates token usage metrics from model API response. */
  updateUsageMetrics(
    responseUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage,
  ): void {
    const metrics = createEmptyMetrics();
    metrics.totalInputTokens = responseUsage.totalInputTokens;
    metrics.totalOutputTokens = responseUsage.totalOutputTokens;
    metrics.firstInputTokenContribution = responseUsage.totalInputTokens;

    if ('cache_read_input_tokens' in responseUsage) {
      metrics.cacheReadInputTokens = responseUsage.cache_read_input_tokens ?? 0;
      metrics.cacheCreationInputTokens =
        responseUsage.cache_creation_input_tokens ?? 0;
      metrics.firstInputTokenContribution +=
        metrics.cacheReadInputTokens + metrics.cacheCreationInputTokens;
    } else if ('cached_tokens' in responseUsage) {
      metrics.cacheReadInputTokens = responseUsage.cached_tokens ?? 0;
    }

    if ('reasoning_tokens' in responseUsage) {
      metrics.reasoningTokens = responseUsage.reasoning_tokens ?? 0;
    }

    if (
      'tool_use_tokens' in responseUsage &&
      responseUsage.tool_use_tokens !== null &&
      responseUsage.tool_use_tokens !== undefined
    ) {
      metrics.toolUseTokens = responseUsage.tool_use_tokens;
    }

    this.usageMetrics = metrics;
    this.hasUsageMetrics = true;
  }

  /** Adds response time in milliseconds to the round total. */
  updateResponseTime(responseTime: number): void {
    this.responseTime += responseTime;
  }

  /** Increments the continuation counter for tracking multi-turn responses. */
  incrementContinuation(): void {
    this.continuationCount += 1;
  }

  /** Returns a copy of the usage metrics captured for this round. */
  get metrics(): RoundUsageMetricsSnapshot | null {
    return this.hasUsageMetrics ? { ...this.usageMetrics } : null;
  }

  /** Converts state to a serializable object for persistence. */
  toObject(): Record<string, any> {
    return {
      currRound: this.currRound,
      continuationCount: this.continuationCount,
      responseTime: this.responseTime,
      metrics: this.metrics,
    };
  }
}

/** Interface for tracking aggregate metrics across all conversation rounds. */
export interface IRunMetricsState {
  firstInputTokens: number;
  totalResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRounds: number;
}

/** Manages global state and aggregates metrics across conversation rounds. */
export class RunMetricsState implements IRunMetricsState {
  firstInputTokens: number;
  totalResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRounds: number;
  public totalCacheReadInputTokens: number = 0;
  public totalCacheCreationInputTokens: number = 0;
  public totalReasoningTokens: number = 0;
  public totalToolUseTokens: number = 0;

  constructor() {
    this.firstInputTokens = 0;
    this.totalResponseTime = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalRounds = 0;
  }

  /** Updates global metrics by incorporating round state data. */
  updateFromRoundMetrics(
    roundMetrics: RoundUsageMetricsSnapshot | null,
    responseTime: number,
  ): void {
    if (roundMetrics) {
      if (this.firstInputTokens === 0) {
        this.firstInputTokens = roundMetrics.firstInputTokenContribution;
      }

      this.totalInputTokens += roundMetrics.totalInputTokens;
      this.totalOutputTokens += roundMetrics.totalOutputTokens;
      this.totalCacheReadInputTokens += roundMetrics.cacheReadInputTokens;
      this.totalCacheCreationInputTokens +=
        roundMetrics.cacheCreationInputTokens;
      this.totalReasoningTokens += roundMetrics.reasoningTokens;
      this.totalToolUseTokens += roundMetrics.toolUseTokens;
    }

    this.totalResponseTime += responseTime;
  }

  incrementRounds(): void {
    this.totalRounds += 1;
  }

  /** Converts global state to a serializable object for persistence. */
  toObject(): Record<string, any> {
    return {
      firstInputTokens: this.firstInputTokens,
      totalResponseTime: this.totalResponseTime,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalRounds: this.totalRounds,
      totalCacheReadInputTokens: this.totalCacheReadInputTokens,
      totalCacheCreationInputTokens: this.totalCacheCreationInputTokens,
      totalReasoningTokens: this.totalReasoningTokens,
      totalToolUseTokens: this.totalToolUseTokens,
    };
  }

  /** Creates a RunMetricsState instance from a persisted state object. */
  static fromObject(stateObj: Record<string, any> | null): RunMetricsState {
    if (!stateObj) {
      return new RunMetricsState();
    }

    const state = new RunMetricsState();
    state.firstInputTokens = stateObj.firstInputTokens ?? 0;
    state.totalResponseTime = stateObj.totalResponseTime ?? 0;
    state.totalInputTokens = stateObj.totalInputTokens ?? 0;
    state.totalOutputTokens = stateObj.totalOutputTokens ?? 0;
    state.totalRounds = stateObj.totalRounds ?? 0;
    state.totalCacheReadInputTokens = stateObj.totalCacheReadInputTokens ?? 0;
    state.totalCacheCreationInputTokens =
      stateObj.totalCacheCreationInputTokens ?? 0;
    state.totalReasoningTokens = stateObj.totalReasoningTokens ?? 0;
    state.totalToolUseTokens = stateObj.totalToolUseTokens ?? 0;
    return state;
  }
}
