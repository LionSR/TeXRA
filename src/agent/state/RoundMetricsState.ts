/**
 * State for tracking metrics within a single conversation round.
 *
 * This class stores distilled metrics (not raw API response objects) for a single
 * round, aligning with Pocket Flow's separation of shared data and compute steps.
 */
export interface IRoundMetricsState {
  currRound: number;
  continuationCount: number;
  responseTime: number;
  /** Computed token usage metrics (not raw API response) */
  tokenMetrics: {
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
    toolUseTokens?: number;
  };
}

/**
 * Manages metrics for a single conversation round.
 *
 * Stores only aggregated metrics instead of raw API usage objects to maintain
 * a clean separation between data and computation.
 */
export class RoundMetricsState implements IRoundMetricsState {
  currRound: number;
  continuationCount: number;
  responseTime: number;
  tokenMetrics: {
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
    toolUseTokens?: number;
  };

  constructor(currRound: number) {
    this.currRound = currRound;
    this.continuationCount = 0;
    this.responseTime = 0;
    this.tokenMetrics = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
  }

  /** Updates token usage metrics from distilled API response. */
  updateTokenMetrics(metrics: {
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
    toolUseTokens?: number;
  }): void {
    this.tokenMetrics = { ...metrics };
  }

  /** Adds response time in milliseconds to the round total. */
  updateResponseTime(responseTime: number): void {
    this.responseTime += responseTime;
  }

  /** Increments the continuation counter for tracking multi-turn responses. */
  incrementContinuation(): void {
    this.continuationCount += 1;
  }

  /** Converts state to a serializable object for persistence. */
  toObject(): Record<string, any> {
    return {
      currRound: this.currRound,
      continuationCount: this.continuationCount,
      responseTime: this.responseTime,
      tokenMetrics: { ...this.tokenMetrics },
    };
  }

  /** Creates a RoundMetricsState instance from a persisted state object. */
  static fromObject(stateObj: Record<string, any> | null): RoundMetricsState {
    if (!stateObj) {
      return new RoundMetricsState(0);
    }

    const state = new RoundMetricsState(stateObj.currRound ?? 0);
    state.continuationCount = stateObj.continuationCount ?? 0;
    state.responseTime = stateObj.responseTime ?? 0;
    state.tokenMetrics = stateObj.tokenMetrics ?? {
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
    return state;
  }
}
