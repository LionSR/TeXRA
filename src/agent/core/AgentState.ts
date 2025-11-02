// Local imports - agent components
import {
  OpenAIAPIResponseUsage,
  AnthropicAPIResponseUsage,
} from './ResponseUsage';

// Local imports - logging
import * as logger from '@logger/logUtils';

const CHANNEL = 'Agent';
logger.initialize(CHANNEL);

/** Interface for tracking metrics within a single conversation round. */
export interface IRoundMetrics {
  currRound: number;
  continuationCount: number;
  responseTime: number;
  APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null;
}

/**
 * Manages per-round metrics tracking token usage, timing, and continuation count.
 * Part of Pocket Flow architecture - stores only round-scoped metrics.
 */
export class RoundMetrics implements IRoundMetrics {
  currRound: number;
  continuationCount: number;
  responseTime: number;
  APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null;

  constructor(currRound: number) {
    this.currRound = currRound;
    this.continuationCount = 0;
    this.responseTime = 0;
    this.APIUsage = null;
  }

  /** Updates token usage metrics from model API response. */
  updateTokenCounts(
    responseUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage,
  ): void {
    this.APIUsage = responseUsage;
  }

  /** Adds response time in milliseconds to the round total. */
  updateResponseTime(responseTime: number): void {
    this.responseTime += responseTime;
  }

  /** Increments the continuation counter for tracking multi-turn responses. */
  incrementContinuation(): void {
    this.continuationCount += 1;
  }

  /** Converts metrics to a serializable object for persistence. */
  toObject(): Record<string, any> {
    const stateObj = {
      currRound: this.currRound,
      continuationCount: this.continuationCount,
      responseTime: this.responseTime,
      APIUsage: this.APIUsage,
    };
    return stateObj;
  }
}

/** Legacy alias for backward compatibility - use RoundMetrics instead. */
export class AgentStateRound extends RoundMetrics {}
export type IAgentStateRound = IRoundMetrics;

/** Interface for tracking session-wide usage metrics across all conversation rounds. */
export interface ISessionUsageMetrics {
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
 * Manages session-wide usage metrics aggregated across all conversation rounds.
 * Part of Pocket Flow architecture - stores only session-scoped usage totals.
 */
export class SessionUsageMetrics implements ISessionUsageMetrics {
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

  /** Updates global metrics by incorporating round metrics. */
  updateFromCurrRound(stateRound: RoundMetrics): void {
    if (stateRound.APIUsage) {
      if (this.firstInputTokens === 0) {
        this.firstInputTokens = stateRound.APIUsage.totalInputTokens;
      }

      // For Anthropic models, handle cache tokens directly from response
      if ('cache_read_input_tokens' in stateRound.APIUsage) {
        const cacheRead = stateRound.APIUsage.cache_read_input_tokens ?? 0;
        const cacheCreation =
          stateRound.APIUsage.cache_creation_input_tokens ?? 0;
        this.totalCacheReadInputTokens += cacheRead;
        this.totalCacheCreationInputTokens += cacheCreation;
        this.firstInputTokens += cacheRead + cacheCreation;
      }
      // For OpenAI models with auto prompt caching, handle cache tokens from prompt_tokens_details
      else if (
        'prompt_tokens_details' in stateRound.APIUsage &&
        stateRound.APIUsage.prompt_tokens_details
      ) {
        const promptDetails = stateRound.APIUsage.prompt_tokens_details as {
          cached_tokens?: number;
        };
        if ('cached_tokens' in promptDetails) {
          this.totalCacheReadInputTokens += promptDetails.cached_tokens ?? 0;
        }
      }

      // For OpenAI models, handle reasoning tokens from completion_tokens_details
      if (
        'completion_tokens_details' in stateRound.APIUsage &&
        stateRound.APIUsage.completion_tokens_details
      ) {
        const completionDetails = stateRound.APIUsage
          .completion_tokens_details as { reasoning_tokens?: number };
        if ('reasoning_tokens' in completionDetails) {
          this.totalReasoningTokens += completionDetails.reasoning_tokens ?? 0;
        }
      }
      // For older OpenAI models, handle reasoning tokens directly
      else if ('reasoning_tokens' in stateRound.APIUsage) {
        this.totalReasoningTokens += stateRound.APIUsage.reasoning_tokens ?? 0;
      }

      // Track tokens used for tool calls
      // Note: Only Google models provide tool_use_tokens (as toolUsePromptTokenCount)
      // OpenAI and Anthropic don't provide this information in their API responses
      if (
        'tool_use_tokens' in stateRound.APIUsage &&
        stateRound.APIUsage.tool_use_tokens !== null &&
        stateRound.APIUsage.tool_use_tokens !== undefined
      ) {
        this.totalToolUseTokens += stateRound.APIUsage.tool_use_tokens;
      }

      // Update global totals
      this.totalInputTokens += stateRound.APIUsage.totalInputTokens;
      this.totalOutputTokens += stateRound.APIUsage.totalOutputTokens;
    }

    this.totalResponseTime += stateRound.responseTime;
  }

  incrementRounds(): void {
    this.totalRounds += 1;
  }

  /** Converts session metrics to a serializable object for persistence. */
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

  /** Creates a SessionUsageMetrics instance from a persisted state object. */
  static fromObject(stateObj: Record<string, any> | null): SessionUsageMetrics {
    if (!stateObj) {
      return new SessionUsageMetrics();
    }

    const state = new SessionUsageMetrics();
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

/** Legacy alias for backward compatibility - use SessionUsageMetrics instead. */
export class AgentStateGlobal extends SessionUsageMetrics {}
export type IAgentStateGlobal = ISessionUsageMetrics;
