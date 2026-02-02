// Third-party imports
import { z } from 'zod';

// Local imports - response usage types
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';
import {
  DEFAULT_TOTALS,
  RunUsageAccumulator,
  RunUsageAccumulatorJSONSchema,
} from './RunUsageAccumulator';

/**
 * Schema for ConversationRoundState snapshot.
 * Defaults are defined inline via .prefault() - schema is the single source of truth.
 */
export const ConversationRoundStateSnapshotSchema = z.object({
  roundIndex: z.int().nonnegative(),
  continuationCount: z.int().nonnegative().prefault(0),
  responseTimeMs: z.number().nonnegative().prefault(0),
  normalizedUsage: NormalizedUsageSchema.nullable().prefault(null),
});

/**
 * Single source of truth for ConversationRoundState serialization format.
 * Uses z.output<> to get the type after parsing (all fields required).
 */
export type ConversationRoundStateSnapshot = z.output<
  typeof ConversationRoundStateSnapshotSchema
>;

export class ConversationRoundState {
  public roundIndex: number;
  public continuationCount = 0;
  public responseTimeMs = 0;
  public normalizedUsage: NormalizedUsage | null = null;

  constructor(roundIndex: number) {
    this.roundIndex = roundIndex;
  }

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): ConversationRoundState {
    const parsed = ConversationRoundStateSnapshotSchema.parse(snapshot);
    const state = new ConversationRoundState(parsed.roundIndex);
    state.continuationCount = parsed.continuationCount;
    state.responseTimeMs = parsed.responseTimeMs;
    state.normalizedUsage = parsed.normalizedUsage;
    return state;
  }

  /** Serialize to a snapshot. */
  toSnapshot(): ConversationRoundStateSnapshot {
    return {
      roundIndex: this.roundIndex,
      continuationCount: this.continuationCount,
      responseTimeMs: this.responseTimeMs,
      normalizedUsage: this.normalizedUsage,
    };
  }

  incrementContinuation(): void {
    this.continuationCount += 1;
  }

  addResponseTime(durationMs: number): void {
    this.responseTimeMs += durationMs;
  }
}

/**
 * Schema for AgentRunState snapshot.
 * Defaults are defined inline via .prefault() - schema is the single source of truth.
 */
export const AgentRunStateSnapshotSchema = z.object({
  totalRounds: z.int().nonnegative().prefault(0),
  totalResponseTimeMs: z.number().nonnegative().prefault(0),
  usageAccumulator: RunUsageAccumulatorJSONSchema.prefault({
    totals: DEFAULT_TOTALS,
    normalizedSnapshots: [],
  }),
});

/**
 * Single source of truth for AgentRunState serialization format.
 * Uses z.output<> to get the type after parsing (all fields required).
 */
export type AgentRunStateSnapshot = z.output<
  typeof AgentRunStateSnapshotSchema
>;

export class AgentRunState {
  public totalRounds = 0;
  public totalResponseTimeMs = 0;
  public readonly usageAccumulator: RunUsageAccumulator;

  constructor(accumulator?: RunUsageAccumulator) {
    this.usageAccumulator = accumulator ?? new RunUsageAccumulator();
  }

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): AgentRunState {
    const parsed = AgentRunStateSnapshotSchema.parse(snapshot);
    const usageAccumulator = RunUsageAccumulator.fromSnapshot(
      parsed.usageAccumulator,
    );
    const state = new AgentRunState(usageAccumulator);
    state.totalRounds = parsed.totalRounds;
    state.totalResponseTimeMs = parsed.totalResponseTimeMs;
    return state;
  }

  /** Serialize to a snapshot. */
  toSnapshot(): AgentRunStateSnapshot {
    return {
      totalRounds: this.totalRounds,
      totalResponseTimeMs: this.totalResponseTimeMs,
      usageAccumulator: this.usageAccumulator.toSnapshot(),
    };
  }

  incrementRounds(): void {
    this.totalRounds += 1;
  }

  /**
   * Record cycle metrics (single source of truth).
   * Used by both reflection flows (via recordRound) and tool-use flows (directly).
   */
  recordCycleMetrics(
    cycleIndex: number,
    responseTimeMs: number,
    normalizedUsage: NormalizedUsage | null,
  ): void {
    if (normalizedUsage) {
      this.usageAccumulator.recordNormalizedUsage(cycleIndex, normalizedUsage);
    }
    this.totalResponseTimeMs += responseTimeMs;
  }

  /**
   * Record round metrics from a ConversationRoundState object.
   * Delegates to recordCycleMetrics() for the actual work.
   */
  recordRound(roundState: ConversationRoundState): void {
    this.recordCycleMetrics(
      roundState.roundIndex,
      roundState.responseTimeMs,
      roundState.normalizedUsage,
    );
  }
}
