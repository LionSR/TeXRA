import type { AgentRunStateSnapshot, NormalizedUsage } from '@shared/schemas';

import { recordNormalizedUsage } from '../usage/RunUsageAccumulator';

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
