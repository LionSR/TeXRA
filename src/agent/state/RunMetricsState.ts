// Local imports - state
import type { RoundMetricsState } from './RoundMetricsState';

/**
 * State for tracking aggregate metrics across all conversation rounds.
 *
 * This class stores only distilled metrics snapshots, not raw API response objects,
 * aligning with Pocket Flow's principle of separating shared data from computation.
 */
export interface IRunMetricsState {
  firstInputTokens: number;
  totalResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRounds: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalReasoningTokens: number;
  totalToolUseTokens: number;
}

/**
 * Manages global state and aggregates metrics across conversation rounds.
 *
 * Stores only aggregated metric values instead of raw API usage objects to maintain
 * a clean boundary between data storage and computation logic.
 */
export class RunMetricsState implements IRunMetricsState {
  firstInputTokens: number;
  totalResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRounds: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalReasoningTokens: number;
  totalToolUseTokens: number;

  constructor() {
    this.firstInputTokens = 0;
    this.totalResponseTime = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalRounds = 0;
    this.totalCacheReadInputTokens = 0;
    this.totalCacheCreationInputTokens = 0;
    this.totalReasoningTokens = 0;
    this.totalToolUseTokens = 0;
  }

  /**
   * Updates global metrics by incorporating distilled metrics from a round state.
   *
   * Accepts a metrics snapshot from the round state rather than mutating via a
   * raw API response object, keeping computation separate from storage.
   */
  updateFromRoundMetrics(roundState: RoundMetricsState): void {
    const metrics = roundState.tokenMetrics;

    if (this.firstInputTokens === 0) {
      this.firstInputTokens = metrics.totalInputTokens;

      // Include cache tokens in first input count
      if (metrics.cacheReadInputTokens !== undefined) {
        this.firstInputTokens += metrics.cacheReadInputTokens;
      }
      if (metrics.cacheCreationInputTokens !== undefined) {
        this.firstInputTokens += metrics.cacheCreationInputTokens;
      }
    }

    // Accumulate cache tokens
    if (metrics.cacheReadInputTokens !== undefined) {
      this.totalCacheReadInputTokens += metrics.cacheReadInputTokens;
    }
    if (metrics.cacheCreationInputTokens !== undefined) {
      this.totalCacheCreationInputTokens += metrics.cacheCreationInputTokens;
    }

    // Accumulate reasoning tokens
    if (metrics.reasoningTokens !== undefined) {
      this.totalReasoningTokens += metrics.reasoningTokens;
    }

    // Accumulate tool use tokens
    if (metrics.toolUseTokens !== undefined) {
      this.totalToolUseTokens += metrics.toolUseTokens;
    }

    // Update global totals
    this.totalInputTokens += metrics.totalInputTokens;
    this.totalOutputTokens += metrics.totalOutputTokens;
    this.totalResponseTime += roundState.responseTime;
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
