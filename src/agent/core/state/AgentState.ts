import { z } from 'zod';

import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';
import {
  RunUsageAccumulatorJSONSchema,
  recordNormalizedUsage,
} from '../usage/RunUsageAccumulator';
export const ConversationRoundStateSnapshotSchema = z.object({
  roundIndex: z.int().nonnegative(),
  continuationCount: z.int().nonnegative().prefault(0),
  responseTimeMs: z.number().nonnegative().prefault(0),
  normalizedUsage: NormalizedUsageSchema.nullable().prefault(null),
});

export type ConversationRoundStateSnapshot = z.output<
  typeof ConversationRoundStateSnapshotSchema
>;

export const AgentRunStateSnapshotSchema = z.object({
  totalRounds: z.int().nonnegative().prefault(0),
  totalResponseTimeMs: z.number().nonnegative().prefault(0),
  usageAccumulator: RunUsageAccumulatorJSONSchema.prefault({}),
});

export type AgentRunStateSnapshot = z.output<
  typeof AgentRunStateSnapshotSchema
>;

/**
 * Record cycle metrics into run state. Mutates run in place.
 * Used by both reflection flows (via recordRound) and tool-use flows (directly).
 */
export function recordCycleMetrics(
  run: AgentRunStateSnapshot,
  responseTimeMs: number,
  normalizedUsage: NormalizedUsage | null,
): void {
  if (normalizedUsage) {
    recordNormalizedUsage(run.usageAccumulator, normalizedUsage);
  } else {
    run.usageAccumulator.latestUsage = null;
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
    roundState.responseTimeMs,
    roundState.normalizedUsage,
  );
}
