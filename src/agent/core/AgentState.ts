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

/** Parsed defaults for ConversationRoundState - derived from schema */
const ROUND_STATE_DEFAULTS = ConversationRoundStateSnapshotSchema.parse({
  roundIndex: 0,
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
  public normalizedUsage: NormalizedUsage | null;

  constructor(roundIndex: number) {
    this.roundIndex = roundIndex;
    this.continuationCount = ROUND_STATE_DEFAULTS.continuationCount;
    this.responseTimeMs = ROUND_STATE_DEFAULTS.responseTimeMs;
    this.normalizedUsage = ROUND_STATE_DEFAULTS.normalizedUsage;
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
    this.normalizedUsage = ROUND_STATE_DEFAULTS.normalizedUsage;
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

/** Parsed defaults for AgentRunState - derived from schema */
const RUN_STATE_DEFAULTS = AgentRunStateSnapshotSchema.parse({});

/**
 * Single source of truth for AgentRunState serialization format.
 * Uses z.output<> to get the type after parsing (all fields required).
 */
export type AgentRunStateSnapshot = z.output<
  typeof AgentRunStateSnapshotSchema
>;

export class AgentRunState {
  public totalRounds: number;
  public totalResponseTimeMs: number;
  public readonly usageAccumulator: RunUsageAccumulator;

  constructor(accumulator?: RunUsageAccumulator) {
    this.totalRounds = RUN_STATE_DEFAULTS.totalRounds;
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

  addResponseTime(durationMs: number): void {
    this.totalResponseTimeMs += durationMs;
  }

  /**
   * Record cycle metrics directly (single source of truth).
   *
   * This is the core implementation used by both reflection and tool-use flows.
   * - Reflection flows call `recordRound()` which delegates here
   * - Tool-use flows call this directly with accumulated cycle values
   *
   * @param cycleIndex - The round/cycle index for usage tracking
   * @param responseTimeMs - Total response time for this cycle
   * @param normalizedUsage - Optional normalized usage data
   */
  recordCycleMetrics(
    cycleIndex: number,
    responseTimeMs: number,
    normalizedUsage: NormalizedUsage | null,
  ): void {
    if (normalizedUsage) {
      this.usageAccumulator.recordNormalizedUsage(cycleIndex, normalizedUsage);
    }
    this.addResponseTime(responseTimeMs);
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
