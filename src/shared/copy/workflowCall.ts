import {
  isTerminalWorkflowCallProgress,
  WORKFLOW_TASK_STATUS_LABEL,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { filterNotNullish } from '@utils/core';
import { formatCompactDuration, formatCostUsd } from '@utils/text/stringUtils';

/**
 * Canonical metadata copy for terminal workflow-call progress on every host.
 */
export function formatWorkflowCallMetadataParts(
  call: WorkflowCallProgress,
): string[] {
  if (
    call.status !== 'completed' &&
    call.status !== 'failed' &&
    (call.status !== 'skipped' || call.reason === 'not-reached')
  ) {
    return [];
  }
  return [
    call.model,
    call.durationMs === undefined
      ? undefined
      : formatCompactDuration(call.durationMs),
    call.totalCostUsd === undefined
      ? undefined
      : formatCostUsd(call.totalCostUsd),
  ].filter(filterNotNullish);
}

/**
 * Completion fold for one phase's calls, shared by every host so the terminal
 * and the progress view can never disagree on what "done" counts. The caller
 * selects the phase's calls — each host already holds them in its own
 * container, and matching them here would duplicate that ownership.
 */
export function workflowPhaseCallProgress(
  calls: readonly WorkflowCallProgress[],
): { readonly done: number; readonly total: number } {
  return {
    done: calls.filter((call) => isTerminalWorkflowCallProgress(call)).length,
    total: calls.length,
  };
}

/**
 * Whole-run failure tally shared by every host, so the terminal and the
 * progress view can never disagree on whether a workflow had failed calls.
 * Mirrors `workflowPhaseCallProgress` in taking a caller-selected call list.
 *
 * `WorkflowCallProgress` carries no `cancelled` variant: a cancelled attempt
 * surfaces in the transcript as a `failed` call, so this count already
 * captures it. Snapshot consumers (`/executions`) read `counts.failed` /
 * `counts.cancelled` directly and do not need this helper.
 */
export function workflowCallFailureTally(
  calls: readonly WorkflowCallProgress[],
): { readonly failed: number } {
  return { failed: calls.filter((call) => call.status === 'failed').length };
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
 * The one explanatory-clause rule for a workflow call, shared by every host: a
 * failure reports its error, and a call the run never reached says so. A user
 * skip is self-explanatory and gets no clause.
 */
export function workflowCallDetail(
  call: WorkflowCallProgress,
): { readonly kind: 'error' | 'note'; readonly text: string } | undefined {
  if (call.status === 'failed') return { kind: 'error', text: call.error };
  if (call.status === 'skipped' && call.reason === 'not-reached') {
    return {
      kind: 'note',
      text: 'The workflow ended before this call was reached.',
    };
  }
  return undefined;
}

/**
 * Canonical plain-text projection for workflow-call progress on every host.
 */
export function formatWorkflowCallLine(call: WorkflowCallProgress): string {
  const metadata = formatWorkflowCallMetadataParts(call);
  const suffix = metadata.length > 0 ? ` · ${metadata.join(' · ')}` : '';
  const detail = workflowCallDetail(call);
  const explanation = detail ? ` — ${detail.text}` : '';
  return `${WORKFLOW_TASK_STATUS_LABEL[call.status]}: ${call.label}${suffix}${explanation}`;
}
