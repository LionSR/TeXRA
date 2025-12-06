// Third-party imports
import { z } from 'zod';

// Local imports - response usage types
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';
import {
  RunUsageAccumulator,
  RunUsageAccumulatorJSONSchema,
} from './RunUsageAccumulator';

// Type imports
import type {
  ExtendedCompletionUsage,
  AnthropicUsage,
  GenerateContentResponseUsageMetadata,
} from './ResponseUsage';

export type NativeResponseUsage =
  | ExtendedCompletionUsage
  | AnthropicUsage
  | GenerateContentResponseUsageMetadata;

export const ConversationRoundStateSnapshotSchema = z.object({
  roundIndex: z.int().nonnegative(),
  continuationCount: z.int().nonnegative(),
  responseTimeMs: z.number().nonnegative(),
  outputFile: z.string(),
  normalizedUsage: NormalizedUsageSchema.nullish(),
});

/**
 * Single source of truth for ConversationRoundState serialization format.
 * Derived from the Zod schema - do not duplicate this definition.
 */
export type ConversationRoundStateSnapshot = z.infer<
  typeof ConversationRoundStateSnapshotSchema
>;

export class ConversationRoundState {
  public roundIndex: number;
  public continuationCount: number;
  public responseTimeMs: number;
  public outputFile: string;
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

  setNormalizedUsage(usage: NormalizedUsage): void {
    this.normalizedUsage = usage;
  }

  clearUsage(): void {
    this.normalizedUsage = null;
  }

  toJSON(): ConversationRoundStateSnapshot {
    return {
      roundIndex: this.roundIndex,
      continuationCount: this.continuationCount,
      responseTimeMs: this.responseTimeMs,
      outputFile: this.outputFile,
      normalizedUsage: this.normalizedUsage,
    };
  }

  static fromJSON(
    json: ConversationRoundStateSnapshot,
  ): ConversationRoundState {
    const state = new ConversationRoundState(json.roundIndex);
    state.continuationCount = json.continuationCount;
    state.responseTimeMs = json.responseTimeMs;
    state.outputFile = json.outputFile;
    state.normalizedUsage = json.normalizedUsage ?? null;
    return state;
  }
}

export const AgentRunStateSnapshotSchema = z.object({
  totalRounds: z.int().nonnegative(),
  totalResponseTimeMs: z.number().nonnegative(),
  usageAccumulator: RunUsageAccumulatorJSONSchema,
});

/**
 * Single source of truth for AgentRunState serialization format.
 * Derived from the Zod schema - do not duplicate this definition.
 */
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

  recordRound(roundState: ConversationRoundState): void {
    if (roundState.normalizedUsage) {
      this.usageAccumulator.recordNormalizedUsage(
        roundState.roundIndex,
        roundState.normalizedUsage,
      );
    }
    this.addResponseTime(roundState.responseTimeMs);
  }

  toJSON(): AgentRunStateSnapshot {
    return {
      totalRounds: this.totalRounds,
      totalResponseTimeMs: this.totalResponseTimeMs,
      usageAccumulator: this.usageAccumulator.toJSON(),
    };
  }

  static fromJSON(
    json: AgentRunStateSnapshot | null | undefined,
  ): AgentRunState {
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
