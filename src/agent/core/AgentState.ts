// Third-party imports
import { z } from 'zod';

// Local imports - response usage types
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';
import {
  DEFAULT_TOTALS,
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

