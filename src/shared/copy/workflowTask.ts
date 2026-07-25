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
 * The one explanatory-clause rule for a workflow task, shared by every host: a
 * failure reports its error, and a task the run never reached says so. A user
 * skip is self-explanatory and gets no clause.
 */
export function workflowTaskDetail(
  task: WorkflowTaskProgress,
): { readonly kind: 'error' | 'note'; readonly text: string } | undefined {
  if (task.status === 'failed') return { kind: 'error', text: task.error };
  if (task.status === 'skipped' && task.reason === 'not-reached') {
    return {
      kind: 'note',
      text: 'The workflow ended before this task was reached.',
    };
  }
  return undefined;
}

/**
 * Canonical plain-text projection for workflow-task progress on every host.
 */
export function formatWorkflowTaskLine(task: WorkflowTaskProgress): string {
  const metadata = formatWorkflowTaskMetadataParts(task);
  const suffix = metadata.length > 0 ? ` · ${metadata.join(' · ')}` : '';
  const detail = workflowTaskDetail(task);
  const explanation = detail ? ` — ${detail.text}` : '';
  return `${WORKFLOW_TASK_STATUS_LABEL[task.status]}: ${task.label}${suffix}${explanation}`;
}
