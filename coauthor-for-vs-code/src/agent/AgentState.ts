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
logger.initializeLogging(CHANNEL);

/**
 * State for a single round (first round or reflection round)
 */
export interface IAgentStateRound {
  currRound: number;
  continuationCount: number;
  responseTime: number;
  outputFile: string;
  APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null;
}

export class AgentStateRound implements IAgentStateRound {
  currRound: number;
  continuationCount: number;
  responseTime: number;
  outputFile: string;
  APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null;

  private constructor(currRound: number) {
    this.currRound = currRound;
    this.continuationCount = 0;
    this.responseTime = 0;
    this.outputFile = '';
    this.APIUsage = null;
  }

  /**
   * Initialize a new AgentStateRound object
   */
  static initialize(currRound: number): AgentStateRound {
    return new AgentStateRound(currRound);
  }

  /**
   * Update token counts based on model response usage
   */
  updateTokenCounts(
    responseUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage,
  ): void {
    this.APIUsage = responseUsage;
  }

  /**
   * Update response time for this round
   */
  updateResponseTime(responseTime: number): void {
    this.responseTime += responseTime;
  }

  /**
   * Increment continuation count for this round
   */
  incrementContinuation(): void {
    this.continuationCount += 1;
  }

  /**
   * Convert round state to object format
   */
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

/**
 * Global state tracking metrics across all rounds
 */
export interface IAgentStateGlobal {
  firstInputTokens: number;
  totalResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRounds: number;
  APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null;
}

export class AgentStateGlobal implements IAgentStateGlobal {
  firstInputTokens: number;
  totalResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRounds: number;
  APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null;

  private constructor() {
    this.firstInputTokens = 0;
    this.totalResponseTime = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalRounds = 0;
    this.APIUsage = null;
  }

  /**
   * Initialize a new AgentStateGlobal object
   */
  static initialize(): AgentStateGlobal {
    return new AgentStateGlobal();
  }

  /**
   * Update global metrics based on round state
   */
  updateFromCurrRound(stateRound: AgentStateRound): void {
    if (stateRound.APIUsage) {
      if (this.firstInputTokens === 0) {
        this.firstInputTokens = stateRound.APIUsage.totalInputTokens;
      }

      // For Anthropic models, handle cache tokens
      if ('cache_read_input_tokens' in stateRound.APIUsage) {
        const cacheRead = stateRound.APIUsage.cache_read_input_tokens ?? 0;
        const cacheCreation =
          stateRound.APIUsage.cache_creation_input_tokens ?? 0;
        this.firstInputTokens += cacheRead + cacheCreation;
        logger.debug(
          CHANNEL,
          `First input tokens: ${this.firstInputTokens}, cache_read: ${cacheRead}, cache_creation: ${cacheCreation}`,
        );
      }

      // Update global totals
      this.totalInputTokens += stateRound.APIUsage.totalInputTokens;
      this.totalOutputTokens += stateRound.APIUsage.totalOutputTokens;
    }

    this.totalResponseTime += stateRound.responseTime;
  }

  /**
   * Convert global state to object format
   */
  toObject(): Record<string, any> {
    return {
      firstInputTokens: this.firstInputTokens,
      totalResponseTime: this.totalResponseTime,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalRounds: this.totalRounds,
      APIUsage: this.APIUsage,
    };
  }

  /**
   * Create AgentStateGlobal object from plain object
   */
  static fromObject(stateObj: Record<string, any> | null): AgentStateGlobal {
    if (!stateObj) {
      return AgentStateGlobal.initialize();
    }

    const state = new AgentStateGlobal();
    state.firstInputTokens = stateObj.firstInputTokens ?? 0;
    state.totalResponseTime = stateObj.totalResponseTime ?? 0;
    state.totalInputTokens = stateObj.totalInputTokens ?? 0;
    state.totalOutputTokens = stateObj.totalOutputTokens ?? 0;
    state.APIUsage = stateObj.APIUsage ?? null;
    return state;
  }
}
