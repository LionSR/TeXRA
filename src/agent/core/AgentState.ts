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

/** Default values for ConversationRoundState */
const ROUND_STATE_DEFAULTS = {
  continuationCount: 0,
  responseTimeMs: 0,
  outputFile: '',
  normalizedUsage: null,
} as const;

export const ConversationRoundStateSnapshotSchema = z.object({
  roundIndex: z.int().nonnegative(),
  continuationCount: z
    .int()
    .nonnegative()
    .prefault(ROUND_STATE_DEFAULTS.continuationCount),
  responseTimeMs: z
    .number()
    .nonnegative()
    .prefault(ROUND_STATE_DEFAULTS.responseTimeMs),
  outputFile: z.string().prefault(ROUND_STATE_DEFAULTS.outputFile),
  normalizedUsage: NormalizedUsageSchema.nullable().prefault(
    ROUND_STATE_DEFAULTS.normalizedUsage,
  ),
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
  public continuationCount: number;
  public responseTimeMs: number;
  public outputFile: string;
  public normalizedUsage: NormalizedUsage | null;

  constructor(roundIndex: number) {
    this.roundIndex = roundIndex;
    this.continuationCount = ROUND_STATE_DEFAULTS.continuationCount;
    this.responseTimeMs = ROUND_STATE_DEFAULTS.responseTimeMs;
    this.outputFile = ROUND_STATE_DEFAULTS.outputFile;
    this.normalizedUsage = ROUND_STATE_DEFAULTS.normalizedUsage;
  }

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): ConversationRoundState {
    const parsed = ConversationRoundStateSnapshotSchema.parse(snapshot);
    const state = new ConversationRoundState(parsed.roundIndex);
    state.continuationCount = parsed.continuationCount;
    state.responseTimeMs = parsed.responseTimeMs;
    state.outputFile = parsed.outputFile;
    state.normalizedUsage = parsed.normalizedUsage;
    return state;
  }

  /** Serialize to a snapshot. */
  toSnapshot(): ConversationRoundStateSnapshot {
    return {
      roundIndex: this.roundIndex,
      continuationCount: this.continuationCount,
      responseTimeMs: this.responseTimeMs,
      outputFile: this.outputFile,
      normalizedUsage: this.normalizedUsage,
    };
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

  /**
   * Reset this round state for a new round.
   * Mutates the existing object to preserve references held by store and services.
   *
   * @param newRoundIndex - The new round index
   */
  reset(newRoundIndex: number): void {
    this.roundIndex = newRoundIndex;
    this.continuationCount = ROUND_STATE_DEFAULTS.continuationCount;
    this.responseTimeMs = ROUND_STATE_DEFAULTS.responseTimeMs;
    this.outputFile = ROUND_STATE_DEFAULTS.outputFile;
    this.normalizedUsage = ROUND_STATE_DEFAULTS.normalizedUsage;
  }
}

/** Default values for AgentRunState */
const RUN_STATE_DEFAULTS = {
  totalResponseTimeMs: 0,
} as const;

export const AgentRunStateSnapshotSchema = z.object({
  totalResponseTimeMs: z
    .number()
    .nonnegative()
    .prefault(RUN_STATE_DEFAULTS.totalResponseTimeMs),
  // Prefault normalizes missing accumulator before validation
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
  public totalResponseTimeMs: number;
  public readonly usageAccumulator: RunUsageAccumulator;

  constructor(accumulator?: RunUsageAccumulator) {
    this.totalResponseTimeMs = RUN_STATE_DEFAULTS.totalResponseTimeMs;
    this.usageAccumulator = accumulator ?? new RunUsageAccumulator();
  }

  /** Deserialize from a snapshot. Validates and applies schema defaults. */
  static fromSnapshot(snapshot: unknown): AgentRunState {
    const parsed = AgentRunStateSnapshotSchema.parse(snapshot);
    const usageAccumulator = RunUsageAccumulator.fromSnapshot(
      parsed.usageAccumulator,
    );
    const state = new AgentRunState(usageAccumulator);
    state.totalResponseTimeMs = parsed.totalResponseTimeMs;
    return state;
  }

  /** Serialize to a snapshot. */
  toSnapshot(): AgentRunStateSnapshot {
    return {
      totalResponseTimeMs: this.totalResponseTimeMs,
      usageAccumulator: this.usageAccumulator.toSnapshot(),
    };
  }

  /**
   * Get the number of completed cycles.
   * Derived from usageAccumulator which is the single source of truth.
   */
  getCompletedCycles(): number {
    return this.usageAccumulator.getCompletedCycles();
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
}
