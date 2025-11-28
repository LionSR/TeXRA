// Third-party imports
import { z } from 'zod';

// Local imports - response usage types
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  RunUsageAccumulator,
  type RunUsageAccumulatorJSON,
  type UsageProvider,
  type UsageSummary,
  type NativeUsagePayload,
} from './RunUsageAccumulator';

// Type imports
import type {
  AnthropicAPIResponseUsage,
  OpenAIAPIResponseUsage,
  ExtendedCompletionUsage,
  AnthropicUsage,
  GenerateContentResponseUsageMetadata,
} from './ResponseUsage';

export type NativeResponseUsage =
  | ExtendedCompletionUsage
  | AnthropicUsage
  | GenerateContentResponseUsageMetadata;

export const ConversationRoundStateSnapshotSchema = z.strictObject({
  roundIndex: z.number().int().nonnegative(),
  continuationCount: z.number().int().nonnegative(),
  responseTimeMs: z.number().nonnegative(),
  outputFile: z.string(),
  // New: store normalized usage directly (nullish for backward compat with old saved states)
  normalizedUsage: z.custom<NormalizedUsage>().nullish(),
  // Legacy fields for backward compatibility (deprecated)
  usageSummary: z.custom<UsageSummary>().nullable().optional(),
  nativeUsage: z.custom<NativeUsagePayload>().nullable().optional(),
  provider: z.custom<UsageProvider>().nullable().optional(),
});

export type ConversationRoundStateSnapshot = z.infer<
  typeof ConversationRoundStateSnapshotSchema
>;

export interface ConversationRoundStateJSON {
  roundIndex: number;
  continuationCount: number;
  responseTimeMs: number;
  outputFile: string;
  // nullish for backward compatibility with old saved states that lack this field
  normalizedUsage?: NormalizedUsage | null;
  // Legacy fields for backward compatibility
  usageSummary?: UsageSummary;
  nativeUsage?: NativeUsagePayload | null;
  provider?: UsageProvider | null;
}

export class ConversationRoundState {
  public roundIndex: number;
  public continuationCount: number;
  public responseTimeMs: number;
  public outputFile: string;
  /** Normalized usage data - the single source of truth */
  public normalizedUsage: NormalizedUsage | null;

  constructor(roundIndex: number) {
    this.roundIndex = roundIndex;
    this.continuationCount = 0;
    this.responseTimeMs = 0;
    this.outputFile = '';
    this.normalizedUsage = null;
  }

  incrementContinuation(): void {
    this.continuationCount += 1;
  }

  addResponseTime(durationMs: number): void {
    this.responseTimeMs += durationMs;
  }

  /**
   * Sets the normalized usage for this round.
   * This is the preferred method - use normalizeUsage() from the model handler.
   */
  setNormalizedUsage(usage: NormalizedUsage): void {
    this.normalizedUsage = usage;
  }

  clearUsage(): void {
    this.normalizedUsage = null;
  }

  toJSON(): ConversationRoundStateJSON {
    return {
      roundIndex: this.roundIndex,
      continuationCount: this.continuationCount,
      responseTimeMs: this.responseTimeMs,
      outputFile: this.outputFile,
      normalizedUsage: this.normalizedUsage,
    };
  }

  static fromJSON(json: ConversationRoundStateJSON): ConversationRoundState {
    const state = new ConversationRoundState(json.roundIndex);
    state.continuationCount = json.continuationCount;
    state.responseTimeMs = json.responseTimeMs;
    state.outputFile = json.outputFile;

    // Load normalized usage if available
    if (json.normalizedUsage) {
      state.normalizedUsage = json.normalizedUsage;
    }
    // Legacy: convert old format if present (for backward compatibility)
    else if (json.usageSummary && json.provider) {
      state.normalizedUsage = {
        inputTokens: json.usageSummary.totalInputTokens,
        outputTokens: json.usageSummary.totalOutputTokens,
        cost: json.usageSummary.cost,
        responseTimeMs: json.usageSummary.responseTime,
        provider: json.provider,
        _native: json.nativeUsage ?? undefined,
      };
    }

    return state;
  }
}

export interface AgentRunStateJSON {
  totalRounds: number;
  totalResponseTimeMs: number;
  usageAccumulator: RunUsageAccumulatorJSON;
}

export const AgentRunStateSnapshotSchema = z.strictObject({
  totalRounds: z.number().int().nonnegative(),
  totalResponseTimeMs: z.number().nonnegative(),
  usageAccumulator: z.custom<RunUsageAccumulatorJSON>(),
});

export type AgentRunStateSnapshot = z.infer<typeof AgentRunStateSnapshotSchema>;

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

  /**
   * Records usage from a completed round using normalized usage.
   */
  recordRound(roundState: ConversationRoundState): void {
    if (roundState.normalizedUsage) {
      this.usageAccumulator.recordNormalizedUsage(
        roundState.roundIndex,
        roundState.normalizedUsage,
      );
    }
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
