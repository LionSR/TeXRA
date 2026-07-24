import type { WorkflowTaskProgress } from '@shared/schemas';
import { formatCompactDuration, formatCostUsd } from '@utils/text/stringUtils';

/**
 * Canonical metadata copy for terminal workflow-task progress on every host.
 */
export function formatWorkflowTaskMetadataParts(
  task: WorkflowTaskProgress,
): string[] {
  if (
    task.status !== 'completed' &&
    task.status !== 'failed' &&
    (task.status !== 'skipped' || task.reason === 'not-reached')
  ) {
    return [];
  }
  return [
    task.model,
    task.durationMs === undefined
      ? undefined
      : formatCompactDuration(task.durationMs),
    task.totalCostUsd === undefined
      ? undefined
      : `${formatCostUsd(task.totalCostUsd)} total`,
  ].filter((part): part is string => part !== undefined);
}
