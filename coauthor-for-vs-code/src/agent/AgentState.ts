import { OpenAIResponseUsage, AnthropicResponseUsage } from './ResponseUsage';
import { debug } from '../logger/logUtils';

/**
 * State for a single round (first round or reflection round)
 */
export interface AgentStateRound {
  currRound: number;
  continuationCount: number;
  responseTime: number;
  outputFile: string;
  modelUsage: OpenAIResponseUsage | AnthropicResponseUsage | null;
}

export class AgentStateRoundImpl implements AgentStateRound {
  currRound: number;
  continuationCount: number;
  responseTime: number;
  outputFile: string;
  modelUsage: OpenAIResponseUsage | AnthropicResponseUsage | null;

  private constructor(currRound: number) {
    this.currRound = currRound;
    this.continuationCount = 0;
    this.responseTime = 0;
    this.outputFile = '';
    this.modelUsage = null;
  }

  /**
   * Initialize a new AgentStateRound object
   */
  static initialize(currRound: number): AgentStateRound {
    return new AgentStateRoundImpl(currRound);
  }

  /**
   * Update token counts based on model response usage
   */
  updateTokenCounts(
    responseUsage: OpenAIResponseUsage | AnthropicResponseUsage,
  ): void {
    this.modelUsage = responseUsage;
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
      modelUsage: this.modelUsage,
    };
    return stateObj;
  }
}

/**
 * Global state tracking metrics across all rounds
 */
export interface AgentStateGlobal {
  firstInputTokens: number;
  totalResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRounds: number;
  modelUsage: OpenAIResponseUsage | AnthropicResponseUsage | null;
}

export class AgentStateGlobalImpl implements AgentStateGlobal {
  firstInputTokens: number;
  totalResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRounds: number;
  modelUsage: OpenAIResponseUsage | AnthropicResponseUsage | null;

  private constructor() {
    this.firstInputTokens = 0;
    this.totalResponseTime = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalRounds = 0;
    this.modelUsage = null;
  }

  /**
   * Initialize a new AgentStateGlobal object
   */
  static initialize(): AgentStateGlobal {
    return new AgentStateGlobalImpl();
  }

  /**
   * Update global metrics based on round state
   */
  updateFromCurrRound(stateRound: AgentStateRound): void {
    if (stateRound.modelUsage) {
      if (this.firstInputTokens === 0) {
        this.firstInputTokens = stateRound.modelUsage.totalInputTokens;
      }

      // For Anthropic models, handle cache tokens
      if ('cacheReadInputTokens' in stateRound.modelUsage) {
        const cacheRead = stateRound.modelUsage.cacheReadInputTokens ?? 0;
        this.firstInputTokens += cacheRead;
        debug(
          'AgentState',
          `First input tokens: ${this.firstInputTokens}, cache_read: ${cacheRead}`,
        );
      }

      // Update global totals
      this.totalInputTokens += stateRound.modelUsage.totalInputTokens;
      this.totalOutputTokens += stateRound.modelUsage.totalOutputTokens;
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
      modelUsage: this.modelUsage,
    };
  }

  /**
   * Create AgentStateGlobal object from plain object
   */
  static fromObject(stateObj: Record<string, any> | null): AgentStateGlobal {
    if (!stateObj) {
      return AgentStateGlobalImpl.initialize();
    }

    const state = new AgentStateGlobalImpl();
    state.firstInputTokens = stateObj.firstInputTokens ?? 0;
    state.totalResponseTime = stateObj.totalResponseTime ?? 0;
    state.totalInputTokens = stateObj.totalInputTokens ?? 0;
    state.totalOutputTokens = stateObj.totalOutputTokens ?? 0;
    state.modelUsage = stateObj.modelUsage ?? null;
    return state;
  }
}
