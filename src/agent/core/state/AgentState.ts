import { z } from 'zod';

import {
  NormalizedUsageSchema,
  type AgentRunStateSnapshot,
  type NormalizedUsage,
} from '@shared/schemas';

import { recordNormalizedUsage } from '../usage/RunUsageAccumulator';

export const ConversationRoundStateSnapshotSchema = z.object({
  roundIndex: z.int().nonnegative(),
  continuationCount: z.int().nonnegative().prefault(0),
  responseTimeMs: z.number().nonnegative().prefault(0),
  normalizedUsage: NormalizedUsageSchema.nullable().prefault(null),
});

export type ConversationRoundStateSnapshot = z.output<
  typeof ConversationRoundStateSnapshotSchema
>;

/**
 * Record cycle metrics into run state. Mutates run in place.
 * Used by both the reflection and tool-use flows.
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
