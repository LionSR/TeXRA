import { z } from 'zod';

import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';
import {
  createDefaultTotals,
  RunUsageAccumulatorJSONSchema,
  recordNormalizedUsage,
} from './RunUsageAccumulator';
export const ConversationRoundStateSnapshotSchema = z.object({
  roundIndex: z.int().nonnegative(),
  continuationCount: z.int().nonnegative().prefault(0),
  responseTimeMs: z.number().nonnegative().prefault(0),
  normalizedUsage: NormalizedUsageSchema.nullable().prefault(null),
});

export type ConversationRoundStateSnapshot = z.output<
  typeof ConversationRoundStateSnapshotSchema
>;

export function createRoundState(
  roundIndex: number,
): ConversationRoundStateSnapshot {
  return ConversationRoundStateSnapshotSchema.parse({ roundIndex });
}

export const AgentRunStateSnapshotSchema = z.object({
  totalRounds: z.int().nonnegative().prefault(0),
  totalResponseTimeMs: z.number().nonnegative().prefault(0),
  usageAccumulator: RunUsageAccumulatorJSONSchema.prefault(() => ({
    totals: createDefaultTotals(),
    normalizedSnapshots: [],
  })),
});

export type AgentRunStateSnapshot = z.output<
  typeof AgentRunStateSnapshotSchema
>;

export function createRunState(): AgentRunStateSnapshot {
  return AgentRunStateSnapshotSchema.parse({});
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

/** Record round metrics from a ConversationRoundState snapshot. */
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
