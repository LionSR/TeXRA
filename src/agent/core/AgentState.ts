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
  createUsageAccumulator,
  recordNormalizedUsage,
  type RunUsageAccumulatorJSON,
} from './RunUsageAccumulator';

// ============================================================================
// ConversationRoundState — plain data + functions
// ============================================================================

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

/** Create a fresh round state for the given round index. */
export function createRoundState(
  roundIndex: number,
): ConversationRoundStateSnapshot {
  return {
    roundIndex,
    continuationCount: 0,
    responseTimeMs: 0,
    normalizedUsage: null,
  };
}

/** Parse and validate a round state snapshot. */
export function parseRoundState(
  snapshot: unknown,
): ConversationRoundStateSnapshot {
  return ConversationRoundStateSnapshotSchema.parse(snapshot);
}

// ============================================================================
// AgentRunState — plain data + functions
// ============================================================================

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

/** Create a fresh run state (all zeros). */
export function createRunState(): AgentRunStateSnapshot {
  return {
    totalRounds: 0,
    totalResponseTimeMs: 0,
    usageAccumulator: createUsageAccumulator(),
  };
}

/** Parse and validate a run state snapshot. */
export function parseRunState(snapshot: unknown): AgentRunStateSnapshot {
  return AgentRunStateSnapshotSchema.parse(snapshot);
}

/**
 * Record cycle metrics into run state. Mutates run in place.
 * Used by both reflection flows (via recordRound) and tool-use flows (directly).
 */
export function recordCycleMetrics(
  run: AgentRunStateSnapshot,
  cycleIndex: number,
  responseTimeMs: number,
  normalizedUsage: NormalizedUsage | null,
): void {
  if (normalizedUsage) {
    recordNormalizedUsage(run.usageAccumulator, cycleIndex, normalizedUsage);
  }
  run.totalResponseTimeMs += responseTimeMs;
}

/**
 * Record round metrics from a ConversationRoundState snapshot.
 * Delegates to recordCycleMetrics() for the actual work.
 */
export function recordRound(
  run: AgentRunStateSnapshot,
  roundState: ConversationRoundStateSnapshot,
): void {
  recordCycleMetrics(
    run,
    roundState.roundIndex,
    roundState.responseTimeMs,
    roundState.normalizedUsage,
  );
}

// ============================================================================
// Backward-compatible classes (delegate to standalone functions)
// ============================================================================

/**
 * @deprecated Use ConversationRoundStateSnapshot + standalone functions instead.
 */
export class ConversationRoundState {
  public roundIndex: number;
  public continuationCount = 0;
  public responseTimeMs = 0;
  public normalizedUsage: NormalizedUsage | null = null;

  constructor(roundIndex: number) {
    this.roundIndex = roundIndex;
  }

  static fromSnapshot(snapshot: unknown): ConversationRoundState {
    const parsed = ConversationRoundStateSnapshotSchema.parse(snapshot);
    const state = new ConversationRoundState(parsed.roundIndex);
    state.continuationCount = parsed.continuationCount;
    state.responseTimeMs = parsed.responseTimeMs;
    state.normalizedUsage = parsed.normalizedUsage;
    return state;
  }

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
 * @deprecated Use AgentRunStateSnapshot + standalone functions instead.
 */
export class AgentRunState {
  public totalRounds = 0;
  public totalResponseTimeMs = 0;
  public readonly usageAccumulator: RunUsageAccumulator;

  constructor(accumulator?: RunUsageAccumulator) {
    this.usageAccumulator = accumulator ?? new RunUsageAccumulator();
  }

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

  recordRound(roundState: ConversationRoundState): void {
    this.recordCycleMetrics(
      roundState.roundIndex,
      roundState.responseTimeMs,
      roundState.normalizedUsage,
    );
  }
}
