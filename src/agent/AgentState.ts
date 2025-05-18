// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - agent components
import {
  OpenAIAPIResponseUsage,
  AnthropicAPIResponseUsage,
} from './ResponseUsage';

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

/** Manages state and metrics for a single conversation round. */
export class AgentStateRound implements IAgentStateRound {
  currRound: number;
  continuationCount: number;
  responseTime: number;
  outputFile: string;
  APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null;

  constructor(currRound: number) {
    this.currRound = currRound;
    this.continuationCount = 0;
    this.responseTime = 0;
    this.outputFile = '';
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

/** Manages global state and aggregates metrics across conversation rounds. */
export class AgentStateGlobal implements IAgentStateGlobal {
  firstInputTokens: number;
  totalResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRounds: number;
  APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null;
  public totalCacheReadInputTokens: number = 0;
  public totalCacheCreationInputTokens: number = 0;
  public totalReasoningTokens: number = 0;

  constructor() {
    this.firstInputTokens = 0;
    this.totalResponseTime = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalRounds = 0;
    this.APIUsage = null;
  }


  /** Updates global metrics by incorporating round state data. */
  updateFromCurrRound(stateRound: AgentStateRound): void {
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

      // Update global totals
      this.totalInputTokens += stateRound.APIUsage.totalInputTokens;
      this.totalOutputTokens += stateRound.APIUsage.totalOutputTokens;
    }

    this.totalResponseTime += stateRound.responseTime;
  }

  // are the following two methods needed?
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
    return state;
  }
}
