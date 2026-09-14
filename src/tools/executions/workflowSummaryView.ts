/**
 * Bounded projection of a workflow run's board — the `workflowRunModel` fold
 * every host paints — for the executions tool's `/executions/{id}` summary.
 *
 * A board is unbounded in phases, cards, and file lists; this renders the
 * slice worth a model's context — open phases still working first, then
 * phases with a failed or cancelled card, then plan order, and within a phase
 * the cards needing attention first — and reports what it omitted so the
 * reader knows the view is truncated rather than complete.
 */

// Local imports
import type {
  WorkflowPhaseModel,
  WorkflowRunModel,
} from '@shared/runs/workflowRunModel';
import {
  WORKFLOW_CALL_STATUS,
  type WorkflowCallProgress,
} from '@shared/schemas';

const WORKFLOW_SUMMARY_MAX_ENTRIES = 8;
const WORKFLOW_SUMMARY_MAX_FILES_PER_KIND = 3;
const WORKFLOW_SUMMARY_TEXT_LENGTH = 160;

function compactWorkflowText(value: string | undefined): string | undefined {
  return value?.slice(0, WORKFLOW_SUMMARY_TEXT_LENGTH);
}

function compactWorkflowFiles(files: readonly string[]): {
  sample: string[];
  omitted?: number;
} {
  return {
    sample: files
      .slice(0, WORKFLOW_SUMMARY_MAX_FILES_PER_KIND)
      .map((file) => compactWorkflowText(file)!),
    ...(files.length > WORKFLOW_SUMMARY_MAX_FILES_PER_KIND && {
      omitted: files.length - WORKFLOW_SUMMARY_MAX_FILES_PER_KIND,
    }),
  };
}

function isAttentionCall(call: WorkflowCallProgress): boolean {
  return (
    call.status === WORKFLOW_CALL_STATUS.FAILED ||
    call.status === WORKFLOW_CALL_STATUS.CANCELLED
  );
}

function isLiveCall(call: WorkflowCallProgress): boolean {
  return (
    call.status === WORKFLOW_CALL_STATUS.QUEUED ||
    call.status === WORKFLOW_CALL_STATUS.RUNNING
  );
}

/** Live calls lead, failures follow, the rest keep transcript order. */
function callPriority(call: WorkflowCallProgress): number {
  if (isLiveCall(call)) return 0;
  if (isAttentionCall(call)) return 1;
  return 2;
}

/** Phases still working lead, phases with a failure follow, then plan order. */
function phasePriority(phase: WorkflowPhaseModel): number {
  if (
    phase.opened &&
    phase.tally.done < phase.tally.total + phase.tally.declared
  )
    return 0;
  if (phase.tasks.some((row) => isAttentionCall(row.call))) return 1;
  return 2;
}

function workflowCallView(call: WorkflowCallProgress): unknown {
  return {
    id: compactWorkflowText(call.id),
    label: compactWorkflowText(call.label),
    status: call.status,
    kind: call.kind,
    agent: compactWorkflowText(call.agent),
    model: compactWorkflowText(call.model),
    childRunId: compactWorkflowText(call.childRunId),
    attemptNumber: call.attemptNumber,
    ...('costUsd' in call && { costUsd: call.costUsd }),
    ...('durationMs' in call && { durationMs: call.durationMs }),
    ...('error' in call && { error: compactWorkflowText(call.error) }),
    ...('reason' in call && { reason: call.reason }),
    ...(call.files !== undefined && {
      files: {
        input: compactWorkflowFiles(call.files.input),
        context: compactWorkflowFiles(call.files.context),
        media: compactWorkflowFiles(call.files.media),
      },
    }),
  };
}

function workflowPhaseView(phase: WorkflowPhaseModel): unknown {
  const tasks = phase.tasks
    .toSorted(
      (left, right) => callPriority(left.call) - callPriority(right.call),
    )
    .slice(0, WORKFLOW_SUMMARY_MAX_ENTRIES);
  const declared = phase.declaredTasks.slice(0, WORKFLOW_SUMMARY_MAX_ENTRIES);
  return {
    title: compactWorkflowText(phase.heading.phaseLabel),
    opened: phase.opened,
    tally: phase.tally,
    tasks: tasks.map((row) => workflowCallView(row.call)),
    ...(phase.tasks.length > tasks.length && {
      omittedTasks: phase.tasks.length - tasks.length,
    }),
    declared: declared.map((task) => compactWorkflowText(task.label)),
    ...(phase.declaredTasks.length > declared.length && {
      omittedDeclared: phase.declaredTasks.length - declared.length,
    }),
  };
}

export function workflowBoardView(model: WorkflowRunModel): unknown {
  const phases = model.phases
    .toSorted((left, right) => phasePriority(left) - phasePriority(right))
    .slice(0, WORKFLOW_SUMMARY_MAX_ENTRIES);
  const shownCalls = phases.reduce(
    (sum, phase) =>
      sum + Math.min(phase.tasks.length, WORKFLOW_SUMMARY_MAX_ENTRIES),
    0,
  );
  return {
    tally: model.tally,
    phases: phases.map(workflowPhaseView),
    ...(model.phases.length > phases.length && {
      omittedPhases: model.phases.length - phases.length,
    }),
    ...(model.tasks.length > shownCalls && {
      omittedCalls: model.tasks.length - shownCalls,
    }),
    responseBounds: {
      maxPhases: WORKFLOW_SUMMARY_MAX_ENTRIES,
      maxTasksPerPhase: WORKFLOW_SUMMARY_MAX_ENTRIES,
      maxFilesPerKind: WORKFLOW_SUMMARY_MAX_FILES_PER_KIND,
    },
  };
}
