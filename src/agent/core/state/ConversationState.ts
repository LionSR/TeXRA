// Local imports - usage types
import {
  type AnthropicAPIResponseUsage,
  type OpenAIAPIResponseUsage,
} from '../ResponseUsage';

export type ModelUsage =
  | OpenAIAPIResponseUsage
  | AnthropicAPIResponseUsage;

/** Snapshot shape for round metrics state. */
export interface RoundMetricsSnapshot {
  roundIndex: number;
  continuationCount: number;
  responseTime: number;
  usage: ModelUsage | null;
}

/** Tracks metrics for a single round within a conversation. */
export class RoundMetricsState {
  roundIndex: number;
  continuationCount: number;
  responseTime: number;
  usage: ModelUsage | null;

  constructor(roundIndex: number) {
    this.roundIndex = roundIndex;
    this.continuationCount = 0;
    this.responseTime = 0;
    this.usage = null;
  }

  /** Records response usage information for the current round. */
  recordUsage(usage: ModelUsage): void {
    this.usage = usage;
  }

  /** Adds response time in seconds for this round. */
  addResponseTime(durationSeconds: number): void {
    this.responseTime += durationSeconds;
  }

  /** Increments the continuation counter. */
  incrementContinuation(): void {
    this.continuationCount += 1;
  }

  /** Converts the state into a serialisable snapshot. */
  toSnapshot(): RoundMetricsSnapshot {
    return {
      roundIndex: this.roundIndex,
      continuationCount: this.continuationCount,
      responseTime: this.responseTime,
      usage: this.usage,
    };
  }
}

/** Snapshot shape for session usage state. */
export interface SessionUsageSnapshot {
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

/** Aggregates usage metrics across all rounds in a session. */
export class SessionUsageState {
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

  /** Incorporates metrics from a round-level snapshot. */
  updateFromRound(round: RoundMetricsState): void {
    if (!round.usage) {
      return;
    }

    if (this.firstInputTokens === 0) {
      this.firstInputTokens = round.usage.totalInputTokens;
    }

    if ('cache_read_input_tokens' in round.usage) {
      const cacheRead = round.usage.cache_read_input_tokens ?? 0;
      const cacheCreation = round.usage.cache_creation_input_tokens ?? 0;
      this.totalCacheReadInputTokens += cacheRead;
      this.totalCacheCreationInputTokens += cacheCreation;
      this.firstInputTokens += cacheRead + cacheCreation;
    } else if (
      'prompt_tokens_details' in round.usage &&
      round.usage.prompt_tokens_details
    ) {
      const promptDetails = round.usage
        .prompt_tokens_details as { cached_tokens?: number };
      if ('cached_tokens' in promptDetails) {
        this.totalCacheReadInputTokens += promptDetails.cached_tokens ?? 0;
      }
    }

    if (
      'completion_tokens_details' in round.usage &&
      round.usage.completion_tokens_details
    ) {
      const completionDetails = round.usage
        .completion_tokens_details as { reasoning_tokens?: number };
      if ('reasoning_tokens' in completionDetails) {
        this.totalReasoningTokens += completionDetails.reasoning_tokens ?? 0;
      }
    } else if ('reasoning_tokens' in round.usage) {
      this.totalReasoningTokens += round.usage.reasoning_tokens ?? 0;
    }

    if ('tool_use_tokens' in round.usage) {
      const toolUseTokens = round.usage.tool_use_tokens;
      if (typeof toolUseTokens === 'number') {
        this.totalToolUseTokens += toolUseTokens;
      }
    }

    this.totalInputTokens += round.usage.totalInputTokens;
    this.totalOutputTokens += round.usage.totalOutputTokens;
    this.totalResponseTime += round.responseTime;
  }

  incrementRounds(): void {
    this.totalRounds += 1;
  }

  toSnapshot(): SessionUsageSnapshot {
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

  static fromSnapshot(snapshot: SessionUsageSnapshot | null): SessionUsageState {
    if (!snapshot) {
      return new SessionUsageState();
    }

    const state = new SessionUsageState();
    state.firstInputTokens = snapshot.firstInputTokens ?? 0;
    state.totalResponseTime = snapshot.totalResponseTime ?? 0;
    state.totalInputTokens = snapshot.totalInputTokens ?? 0;
    state.totalOutputTokens = snapshot.totalOutputTokens ?? 0;
    state.totalRounds = snapshot.totalRounds ?? 0;
    state.totalCacheReadInputTokens = snapshot.totalCacheReadInputTokens ?? 0;
    state.totalCacheCreationInputTokens =
      snapshot.totalCacheCreationInputTokens ?? 0;
    state.totalReasoningTokens = snapshot.totalReasoningTokens ?? 0;
    state.totalToolUseTokens = snapshot.totalToolUseTokens ?? 0;
    return state;
  }
}
