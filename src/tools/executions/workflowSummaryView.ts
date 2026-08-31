/**
 * Bounded projection of a workflow run's execution snapshot for the executions
 * tool's `/executions/{id}` summary.
 *
 * A live workflow snapshot is unbounded in stages, calls, attempts, and file
 * lists; this renders the slice worth a model's context — current stage first,
 * then failed/cancelled outcomes — and reports what it omitted so the reader
 * knows the view is truncated rather than complete.
 */

// Local imports
import {
  deriveWorkflowCounts,
  stageTitleFor,
  TERMINAL_WORKFLOW_CALL_STATUSES,
  type WorkflowExecutionSnapshot,
  WORKFLOW_CALL_STATUS,
} from '@shared/schemas';

const WORKFLOW_SUMMARY_MAX_ENTRIES = 8;
const WORKFLOW_SUMMARY_MAX_ATTEMPTS = 2;
const WORKFLOW_SUMMARY_MAX_FILES_PER_KIND = 3;
const WORKFLOW_SUMMARY_TEXT_LENGTH = 160;

function compactWorkflowText(value: string | undefined): string | undefined {
  return value?.slice(0, WORKFLOW_SUMMARY_TEXT_LENGTH);
}

function workflowPhaseView(
  stage: WorkflowExecutionSnapshot['stages'][number],
): unknown {
  return {
    id: compactWorkflowText(stage.id),
    title: compactWorkflowText(stage.title),
    order: stage.order,
    lifecycle: stage.lifecycle,
    startedAt: stage.startedAt,
    completedAt: stage.completedAt,
  };
}

function workflowAttemptView(
  attempt: WorkflowExecutionSnapshot['calls'][number]['attempts'][number],
): unknown {
  return {
    number: attempt.number,
    id: compactWorkflowText(attempt.id),
    childStreamId: compactWorkflowText(attempt.childStreamId),
    model: compactWorkflowText(attempt.model),
    costUsd: attempt.costUsd,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
  };
}

function workflowCallFailurePriority(status: string): number {
  // Within terminal calls, elevate failed/cancelled so the bounded projection
  // keeps the outcomes that matter for debugging (matches stage ranking).
  if (
    status === WORKFLOW_CALL_STATUS.FAILED ||
    status === WORKFLOW_CALL_STATUS.CANCELLED
  ) {
    return 0;
  }
  return 1;
}

export function workflowExecutionView(
  snapshot: WorkflowExecutionSnapshot,
): unknown {
  const byPriority = snapshot.calls.toSorted(
    (left, right) =>
      Number(TERMINAL_WORKFLOW_CALL_STATUSES.has(left.status)) -
        Number(TERMINAL_WORKFLOW_CALL_STATUSES.has(right.status)) ||
      workflowCallFailurePriority(left.status) -
        workflowCallFailurePriority(right.status) ||
      Number(left.stageId !== snapshot.currentStageId) -
        Number(right.stageId !== snapshot.currentStageId) ||
      right.timestamps.updatedAt.localeCompare(left.timestamps.updatedAt),
  );
  const phases = snapshot.stages
    .toSorted((left, right) => {
      const priority = (stage: (typeof snapshot.stages)[number]): number => {
        if (stage.id === snapshot.currentStageId) return 0;
        if (stage.lifecycle === 'failed' || stage.lifecycle === 'cancelled') {
          return 1;
        }
        return 2;
      };
      return priority(left) - priority(right) || right.order - left.order;
    })
    .slice(0, WORKFLOW_SUMMARY_MAX_ENTRIES)
    .map(workflowPhaseView);
  const calls = byPriority
    .slice(0, WORKFLOW_SUMMARY_MAX_ENTRIES)
    .map((call) => {
      const compactFiles = (files: readonly string[]) => ({
        sample: files
          .slice(0, WORKFLOW_SUMMARY_MAX_FILES_PER_KIND)
          .map((file) => compactWorkflowText(file)!),
        ...(files.length > WORKFLOW_SUMMARY_MAX_FILES_PER_KIND && {
          omitted: files.length - WORKFLOW_SUMMARY_MAX_FILES_PER_KIND,
        }),
      });
      return {
        id: compactWorkflowText(call.id),
        label: compactWorkflowText(call.label),
        phaseId: compactWorkflowText(call.stageId),
        phaseTitle: compactWorkflowText(stageTitleFor(snapshot, call)),
        ...(call.issued && { issued: true, kind: call.kind }),
        agent: compactWorkflowText(call.agent),
        model: compactWorkflowText(call.model),
        files: {
          input: compactFiles(call.files.input),
          context: compactFiles(call.files.context),
          media: compactFiles(call.files.media),
        },
        childExecutionId: compactWorkflowText(call.childExecutionId),
        childStreamId: compactWorkflowText(call.childStreamId),
        attempts: call.attempts
          .slice(-WORKFLOW_SUMMARY_MAX_ATTEMPTS)
          .map(workflowAttemptView),
        ...(call.attempts.length > WORKFLOW_SUMMARY_MAX_ATTEMPTS && {
          omittedAttempts: call.attempts.length - WORKFLOW_SUMMARY_MAX_ATTEMPTS,
        }),
        status: call.status,
        ...(call.settledBySweep && { settledBySweep: true }),
        ...(call.status === WORKFLOW_CALL_STATUS.FAILED && {
          error: compactWorkflowText(call.error),
        }),
        costUsd: call.costUsd,
        timestamps: call.timestamps,
      };
    });
  const currentPhase = snapshot.stages.find(
    (stage) => stage.id === snapshot.currentStageId,
  );
  return {
    aggregate: {
      lifecycle: snapshot.lifecycle,
      error: compactWorkflowText(snapshot.error),
      counts: deriveWorkflowCounts(snapshot.calls),
      timestamps: snapshot.timestamps,
      responseBounds: {
        maxPhases: WORKFLOW_SUMMARY_MAX_ENTRIES,
        maxCalls: WORKFLOW_SUMMARY_MAX_ENTRIES,
        maxAttemptsPerCall: WORKFLOW_SUMMARY_MAX_ATTEMPTS,
        maxFilesPerKind: WORKFLOW_SUMMARY_MAX_FILES_PER_KIND,
      },
    },
    currentPhase: currentPhase ? workflowPhaseView(currentPhase) : null,
    phases,
    calls,
    ...(snapshot.stages.length > phases.length && {
      omittedPhases: snapshot.stages.length - phases.length,
    }),
    ...(snapshot.calls.length > calls.length && {
      omittedCalls: snapshot.calls.length - calls.length,
    }),
  };
}
