import {
  isTerminalWorkflowTaskProgress,
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
      : formatCostUsd(task.totalCostUsd),
  ].filter((part): part is string => part !== undefined);
}

/**
 * Completion fold for one phase's tasks, shared by every host so the terminal
 * and the progress view can never disagree on what "done" counts. The caller
 * selects the phase's tasks — each host already holds them in its own
 * container, and matching them here would duplicate that ownership.
 */
export function workflowPhaseTaskProgress(
  tasks: readonly WorkflowTaskProgress[],
): { readonly done: number; readonly total: number } {
  return {
    done: tasks.filter((task) => isTerminalWorkflowTaskProgress(task)).length,
    total: tasks.length,
  };
}

/** One workflow phase as its emitter names and orders it. */
export interface WorkflowPhaseHeading {
  readonly phaseLabel: string;
  /** 0-based phase order within the run, when the emitter provides it. */
  readonly phaseIndex?: number;
  /** Total phase count for the run, when the emitter provides it. */
  readonly phaseTotal?: number;
}

/**
 * Canonical heading copy for one workflow phase (`Reduce (2/3)`), shared by
 * every surface that names a phase: the transcript's `◆` divider, the live
 * run-status band, and the focused run's child-list group headers. The leading
 * glyph is left to the caller — the band deliberately carries none. The index
 * is 0-based on the wire and 1-based in the copy.
 */
export function formatWorkflowPhaseHeading(
  phase: WorkflowPhaseHeading,
): string {
  const counts =
    phase.phaseIndex !== undefined && phase.phaseTotal !== undefined
      ? ` (${phase.phaseIndex + 1}/${phase.phaseTotal})`
      : '';
  return `${phase.phaseLabel}${counts}`;
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
