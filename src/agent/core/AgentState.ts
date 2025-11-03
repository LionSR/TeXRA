// Local imports - response usage types
import type {
  AnthropicAPIResponseUsage,
  OpenAIAPIResponseUsage,
  ExtendedCompletionUsage,
  AnthropicUsage,
  GenerateContentResponseUsageMetadata,
} from './ResponseUsage';

// Local imports - usage accumulator
import {
  RunUsageAccumulator,
  type RunUsageAccumulatorJSON,
  type UsageProvider,
  type UsageSummary,
  type NativeUsagePayload,
} from './RunUsageAccumulator';

export type NativeResponseUsage =
  | ExtendedCompletionUsage
  | AnthropicUsage
  | GenerateContentResponseUsageMetadata;

export interface ConversationRoundStateJSON {
  roundIndex: number;
  continuationCount: number;
  responseTimeMs: number;
  outputFile: string;
  usageSummary: UsageSummary;
  nativeUsage: NativeUsagePayload | null;
  provider: UsageProvider | null;
}

export class ConversationRoundState {
  public roundIndex: number;
  public continuationCount: number;
  public responseTimeMs: number;
  public outputFile: string;
  public usageSummary: UsageSummary;
  public nativeUsage: NativeUsagePayload | null;
  public provider: UsageProvider | null;

  constructor(roundIndex: number) {
    this.roundIndex = roundIndex;
    this.continuationCount = 0;
    this.responseTimeMs = 0;
    this.outputFile = '';
    this.usageSummary = null;
    this.nativeUsage = null;
    this.provider = null;
  }

  incrementContinuation(): void {
    this.continuationCount += 1;
  }

  addResponseTime(durationMs: number): void {
    this.responseTimeMs += durationMs;
  }

  setUsage(params: {
    summary: UsageSummary;
    nativeUsage?: NativeUsagePayload | null;
    provider: UsageProvider;
  }): void {
    this.usageSummary = params.summary;
    this.nativeUsage = params.nativeUsage ?? null;
    this.provider = params.provider;
  }

  clearUsage(): void {
    this.usageSummary = null;
    this.nativeUsage = null;
    this.provider = null;
  }

  toJSON(): ConversationRoundStateJSON {
    return {
      roundIndex: this.roundIndex,
      continuationCount: this.continuationCount,
      responseTimeMs: this.responseTimeMs,
      outputFile: this.outputFile,
      usageSummary: this.usageSummary,
      nativeUsage: this.nativeUsage,
      provider: this.provider,
    };
  }

  static fromJSON(json: ConversationRoundStateJSON): ConversationRoundState {
    const state = new ConversationRoundState(json.roundIndex);
    state.continuationCount = json.continuationCount;
    state.responseTimeMs = json.responseTimeMs;
    state.outputFile = json.outputFile;
    state.usageSummary = json.usageSummary;
    state.nativeUsage = json.nativeUsage;
    state.provider = json.provider;
    return state;
  }
}

export interface AgentRunStateJSON {
  totalRounds: number;
  totalResponseTimeMs: number;
  usageAccumulator: RunUsageAccumulatorJSON;
}

export class AgentRunState {
  public totalRounds: number;
  public totalResponseTimeMs: number;
  public readonly usageAccumulator: RunUsageAccumulator;

  constructor(accumulator?: RunUsageAccumulator) {
    this.totalRounds = 0;
    this.totalResponseTimeMs = 0;
    this.usageAccumulator = accumulator ?? new RunUsageAccumulator();
  }

  incrementRounds(): void {
    this.totalRounds += 1;
  }

  addResponseTime(durationMs: number): void {
    this.totalResponseTimeMs += durationMs;
  }

  recordRound(roundState: ConversationRoundState): void {
    this.usageAccumulator.recordRoundUsage({
      round: roundState.roundIndex,
      provider: roundState.provider ?? 'unknown',
      summary: roundState.usageSummary,
      nativeUsage: roundState.nativeUsage ?? undefined,
    });
    this.addResponseTime(roundState.responseTimeMs);
  }

  toJSON(): AgentRunStateJSON {
    return {
      totalRounds: this.totalRounds,
      totalResponseTimeMs: this.totalResponseTimeMs,
      usageAccumulator: this.usageAccumulator.toJSON(),
    };
  }

  static fromJSON(json: AgentRunStateJSON | null | undefined): AgentRunState {
    if (!json) {
      return new AgentRunState();
    }

    const usageAccumulator = RunUsageAccumulator.fromJSON(
      json.usageAccumulator,
    );
    const state = new AgentRunState(usageAccumulator);
    state.totalRounds = json.totalRounds;
    state.totalResponseTimeMs = json.totalResponseTimeMs;
    return state;
  }
}

export type ProviderUsageSummary =
  | OpenAIAPIResponseUsage
  | AnthropicAPIResponseUsage;
