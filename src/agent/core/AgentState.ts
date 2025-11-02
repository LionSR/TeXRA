// Local imports - agent components
import {
  OpenAIAPIResponseUsage,
  AnthropicAPIResponseUsage,
} from './ResponseUsage';

// Local imports - new state modules
import { RoundMetricsState, RunMetricsState } from '@agent/state';

// Local imports - logging
import * as logger from '@logger/logUtils';

const CHANNEL = 'Agent';
logger.initialize(CHANNEL);

/** Interface for tracking state within a single conversation round. */
export interface IAgentStateRound {
  currRound: number;
  continuationCount: number;
  responseTime: number;
  outputFile: string;
  APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null;
}

/**
 * Manages state and metrics for a single conversation round.
 *
 * @deprecated This class is maintained for backward compatibility. New code should
 * use RoundMetricsState from @agent/state which stores only distilled metrics
 * (not raw API response objects) and doesn't track outputFile (which is managed
 * by flows). This aligns with Pocket Flow's separation of shared data and compute.
 *
 * Internally, this class now delegates to RoundMetricsState for metric storage.
 */
export class AgentStateRound implements IAgentStateRound {
  /** Internal metrics state using new focused structure */
  private _metrics: RoundMetricsState;

  /** Stored for backward compatibility - flows should track this separately */
  outputFile: string;

  /** Stored for backward compatibility - raw API response */
  APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null;

  constructor(currRound: number) {
    this._metrics = new RoundMetricsState(currRound);
    this.outputFile = '';
    this.APIUsage = null;
  }

  // Proxy properties to internal metrics
  get currRound(): number {
    return this._metrics.currRound;
  }

  set currRound(value: number) {
    this._metrics.currRound = value;
  }

  get continuationCount(): number {
    return this._metrics.continuationCount;
  }

  set continuationCount(value: number) {
    this._metrics.continuationCount = value;
  }

  get responseTime(): number {
    return this._metrics.responseTime;
  }

  set responseTime(value: number) {
    this._metrics.responseTime = value;
  }

  /** Updates token usage metrics from model API response. */
  updateTokenCounts(
    responseUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage,
  ): void {
    this.APIUsage = responseUsage;

    // Convert to distilled metrics
    const metrics: any = {
      totalInputTokens: responseUsage.totalInputTokens,
      totalOutputTokens: responseUsage.totalOutputTokens,
    };

    // Extract cache tokens based on provider
    if ('cache_read_input_tokens' in responseUsage) {
      metrics.cacheReadInputTokens = responseUsage.cache_read_input_tokens ?? 0;
      metrics.cacheCreationInputTokens =
        responseUsage.cache_creation_input_tokens ?? 0;
    } else if (
      'prompt_tokens_details' in responseUsage &&
      responseUsage.prompt_tokens_details
    ) {
      const promptDetails = responseUsage.prompt_tokens_details as {
        cached_tokens?: number;
      };
      if ('cached_tokens' in promptDetails) {
        metrics.cacheReadInputTokens = promptDetails.cached_tokens ?? 0;
      }
    }

    // Extract reasoning tokens
    if (
      'completion_tokens_details' in responseUsage &&
      responseUsage.completion_tokens_details
    ) {
      const completionDetails = responseUsage.completion_tokens_details as {
        reasoning_tokens?: number;
      };
      if ('reasoning_tokens' in completionDetails) {
        metrics.reasoningTokens = completionDetails.reasoning_tokens ?? 0;
      }
    } else if ('reasoning_tokens' in responseUsage) {
      metrics.reasoningTokens = responseUsage.reasoning_tokens ?? 0;
    }

    // Extract tool use tokens
    if (
      'tool_use_tokens' in responseUsage &&
      responseUsage.tool_use_tokens !== null &&
      responseUsage.tool_use_tokens !== undefined
    ) {
      metrics.toolUseTokens = responseUsage.tool_use_tokens;
    }

    this._metrics.updateTokenMetrics(metrics);
  }

  /** Adds response time in milliseconds to the round total. */
  updateResponseTime(responseTime: number): void {
    this._metrics.updateResponseTime(responseTime);
  }

  /** Increments the continuation counter for tracking multi-turn responses. */
  incrementContinuation(): void {
    this._metrics.incrementContinuation();
  }

  /** Converts state to a serializable object for persistence. */
  toObject(): Record<string, any> {
    const stateObj = {
      currRound: this.currRound,
      continuationCount: this.continuationCount,
      responseTime: this.responseTime,
      outputFile: this.outputFile,
      APIUsage: this.APIUsage,
    };
    return stateObj;
  }

  /**
   * Gets the internal RoundMetricsState for code that wants to use the new structure.
   * @internal
   */
  getMetrics(): RoundMetricsState {
    return this._metrics;
  }

  /**
   * Creates an AgentStateRound from an existing RoundMetricsState.
   * @internal
   */
  static fromMetrics(metrics: RoundMetricsState): AgentStateRound {
    const state = new AgentStateRound(metrics.currRound);
    state._metrics = metrics;
    return state;
  }
}

/** Interface for tracking aggregate metrics across all conversation rounds. */
export interface IAgentStateGlobal {
  firstInputTokens: number;
  totalResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRounds: number;
  APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null;
}

/**
 * Manages global state and aggregates metrics across conversation rounds.
 *
 * @deprecated This class is maintained for backward compatibility. New code should
 * use RunMetricsState from @agent/state which stores only aggregated metrics
 * (not raw API response objects). The APIUsage field in this class was never updated
 * and remained null, highlighting the confusion of storing raw responses here.
 *
 * Internally, this class now delegates to RunMetricsState for metric aggregation.
 */
export class AgentStateGlobal implements IAgentStateGlobal {
  /** Internal run metrics using new focused structure */
  private _metrics: RunMetricsState;

  /** Stored for backward compatibility - never updated, always null */
  APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null;

  constructor() {
    this._metrics = new RunMetricsState();
    this.APIUsage = null;
  }

  // Proxy properties to internal metrics
  get firstInputTokens(): number {
    return this._metrics.firstInputTokens;
  }

  set firstInputTokens(value: number) {
    this._metrics.firstInputTokens = value;
  }

  get totalResponseTime(): number {
    return this._metrics.totalResponseTime;
  }

  set totalResponseTime(value: number) {
    this._metrics.totalResponseTime = value;
  }

  get totalInputTokens(): number {
    return this._metrics.totalInputTokens;
  }

  set totalInputTokens(value: number) {
    this._metrics.totalInputTokens = value;
  }

  get totalOutputTokens(): number {
    return this._metrics.totalOutputTokens;
  }

  set totalOutputTokens(value: number) {
    this._metrics.totalOutputTokens = value;
  }

  get totalRounds(): number {
    return this._metrics.totalRounds;
  }

  set totalRounds(value: number) {
    this._metrics.totalRounds = value;
  }

  get totalCacheReadInputTokens(): number {
    return this._metrics.totalCacheReadInputTokens;
  }

  set totalCacheReadInputTokens(value: number) {
    this._metrics.totalCacheReadInputTokens = value;
  }

  get totalCacheCreationInputTokens(): number {
    return this._metrics.totalCacheCreationInputTokens;
  }

  set totalCacheCreationInputTokens(value: number) {
    this._metrics.totalCacheCreationInputTokens = value;
  }

  get totalReasoningTokens(): number {
    return this._metrics.totalReasoningTokens;
  }

  set totalReasoningTokens(value: number) {
    this._metrics.totalReasoningTokens = value;
  }

  get totalToolUseTokens(): number {
    return this._metrics.totalToolUseTokens;
  }

  set totalToolUseTokens(value: number) {
    this._metrics.totalToolUseTokens = value;
  }

  /** Updates global metrics by incorporating round state data. */
  updateFromCurrRound(stateRound: AgentStateRound): void {
    this._metrics.updateFromRoundMetrics(stateRound.getMetrics());
  }

  incrementRounds(): void {
    this._metrics.incrementRounds();
  }

  /** Converts global state to a serializable object for persistence. */
  toObject(): Record<string, any> {
    return {
      firstInputTokens: this.firstInputTokens,
      totalResponseTime: this.totalResponseTime,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalRounds: this.totalRounds,
      APIUsage: this.APIUsage,
      totalCacheReadInputTokens: this.totalCacheReadInputTokens,
      totalCacheCreationInputTokens: this.totalCacheCreationInputTokens,
      totalReasoningTokens: this.totalReasoningTokens,
      totalToolUseTokens: this.totalToolUseTokens,
    };
  }

  /** Creates an AgentStateGlobal instance from a persisted state object. */
  static fromObject(stateObj: Record<string, any> | null): AgentStateGlobal {
    if (!stateObj) {
      return new AgentStateGlobal();
    }

    const state = new AgentStateGlobal();
    state.firstInputTokens = stateObj.firstInputTokens ?? 0;
    state.totalResponseTime = stateObj.totalResponseTime ?? 0;
    state.totalInputTokens = stateObj.totalInputTokens ?? 0;
    state.totalOutputTokens = stateObj.totalOutputTokens ?? 0;
    state.totalRounds = stateObj.totalRounds ?? 0;
    state.APIUsage = stateObj.APIUsage ?? null;
    state.totalCacheReadInputTokens = stateObj.totalCacheReadInputTokens ?? 0;
    state.totalCacheCreationInputTokens =
      stateObj.totalCacheCreationInputTokens ?? 0;
    state.totalReasoningTokens = stateObj.totalReasoningTokens ?? 0;
    state.totalToolUseTokens = stateObj.totalToolUseTokens ?? 0;
    return state;
  }

  /**
   * Gets the internal RunMetricsState for code that wants to use the new structure.
   * @internal
   */
  getMetrics(): RunMetricsState {
    return this._metrics;
  }

  /**
   * Creates an AgentStateGlobal from an existing RunMetricsState.
   * @internal
   */
  static fromMetrics(metrics: RunMetricsState): AgentStateGlobal {
    const state = new AgentStateGlobal();
    state._metrics = metrics;
    return state;
  }
}
