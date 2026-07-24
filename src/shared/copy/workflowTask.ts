import {
  WORKFLOW_TASK_STATUS_LABEL,
  type WorkflowTaskProgress,
} from '@shared/schemas';
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

/**
 * Canonical plain-text projection for workflow-task progress on every host.
 */
export function formatWorkflowTaskLine(task: WorkflowTaskProgress): string {
  const metadata = formatWorkflowTaskMetadataParts(task);
  const suffix = metadata.length > 0 ? ` · ${metadata.join(' · ')}` : '';
  const detail = task.status === 'failed' ? ` — ${task.error}` : '';
  return `${WORKFLOW_TASK_STATUS_LABEL[task.status]}: ${task.label}${suffix}${detail}`;
}
