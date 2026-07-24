// Local imports - agent runtime
import type { AgentTrace, StageHandle } from '@agent/trace';
import {
  runPersistedWorkflowScript,
  type PersistedWorkflowScriptRunOptions,
  type WorkflowJournalEntry,
  type WorkflowScriptEvent,
  type WorkflowScriptProgressId,
  type WorkflowScriptRunResult,
} from '@agent/workflowScript';
import { AgentFinalResultSchema } from '@agent/runtime/AgentFinalResult';
import {
  RUN_OUTCOME,
  type RunOutcome,
  type WorkflowTaskProgress,
} from '@shared/schemas';
import { formatWorkflowTaskMetadataParts } from '@shared/copy/workflowTask';
import { assertNever, generateShortId } from '@utils/core';

type WorkflowScriptRunWithProgressOptions = Omit<
  PersistedWorkflowScriptRunOptions,
  'onEvent'
> & {
  /** Cumulative live spend across this run's children, for progress lines. */
  readonly getLiveCostUsd?: () => number;
  /**
   * Receives every progress line also written to the trace (phases, script
   * log() output, per-call outcomes) so the caller can hand the run log back
   * to the invoking model, which otherwise cannot see any of it.
   */
  readonly onActivity?: (line: string) => void;
};

interface PhaseStage {
  readonly handle: StageHandle;
  failed: boolean;
}

interface ProjectedWorkflowTask {
  readonly logId: string;
  readonly stageId: string | undefined;
  readonly definition: Pick<WorkflowTaskProgress, 'id' | 'label' | 'phase'>;
  status: WorkflowTaskProgress['status'];
}

export class WorkflowJournalCostError extends Error {
  constructor(index: number, options?: ErrorOptions) {
    super(
      `Workflow journal entry ${index} is not an agent final result.`,
      options,
    );
    this.name = 'WorkflowJournalCostError';
  }
}

/**
 * Stable identity for excluding a previously settled journal entry.
 */
export function workflowJournalEntryCostIdentity(
  entry: Pick<WorkflowJournalEntry, 'index' | 'key'>,
): string {
  return `${entry.index}:${entry.key}`;
}

function workflowJournalEntryCost(entry: WorkflowJournalEntry): number {
  const result = AgentFinalResultSchema.safeParse(entry.result);
  if (!result.success) {
    throw new WorkflowJournalCostError(entry.index, {
      cause: result.error,
    });
  }
  return result.data.cost;
}

/**
 * Sum completed logical-call cost. Failed and cancelled attempts are not
 * journaled. Every entry is validated.
 */
export function sumCompletedWorkflowJournalCost(
  journal: readonly WorkflowJournalEntry[],
): number {
  let total = 0;
  for (const entry of journal) {
    total += workflowJournalEntryCost(entry);
  }
  return total;
}

/**
 * Sum cost attributable to the current run, including attempts discarded by
 * skip/retry/failure. The journal supplies an authoritative completed-attempt
 * cost when an observer reports no value; taking the per-call maximum avoids
 * counting the completed attempt twice when both sources report it.
 */
export function sumCurrentWorkflowRunCost(
  journal: readonly WorkflowJournalEntry[],
  observedCosts: ReadonlyMap<string, number>,
): number {
  const unjournaledCosts = new Map(observedCosts);
  let total = 0;
  for (const entry of journal) {
    const journalCost = workflowJournalEntryCost(entry);
    const identity = workflowJournalEntryCostIdentity(entry);
    if (unjournaledCosts.has(identity)) {
      total += Math.max(journalCost, unjournaledCosts.get(identity) ?? 0);
      unjournaledCosts.delete(identity);
    }
  }
  for (const observedCost of unjournaledCosts.values()) {
    total += observedCost;
  }
  return total;
}

/** Run a durable workflow script and project its progress onto the parent trace. */
export async function runPersistedWorkflowScriptWithProgress(
  trace: AgentTrace,
  options: WorkflowScriptRunWithProgressOptions,
): Promise<WorkflowScriptRunResult> {
  const { getLiveCostUsd, onActivity, ...runOptions } = options;
  const parentStageId = trace.activeStageId();
  const phases = new Map<string, PhaseStage>();
  const callPhases = new Map<WorkflowScriptProgressId, string | undefined>();
  const projectedTasks = new Map<
    WorkflowScriptProgressId,
    ProjectedWorkflowTask
  >();
  let currentPhase: string | undefined;
  let closed = false;
  let runOutcome: RunOutcome = RUN_OUTCOME.FAILED;

  const phaseFor = (
    title: string,
    index?: number,
    total?: number,
  ): PhaseStage => {
    const existing = phases.get(title);
    if (existing) return existing;
    const phase = {
      handle: trace.openStage(title, {
        kind: 'phase',
        parentId: parentStageId,
        index,
        total,
      }),
      failed: false,
    };
    phases.set(title, phase);
    return phase;
  };

  const stageIdFor = (
    phase: string | undefined,
    index?: number,
    total?: number,
  ): string | undefined =>
    phase ? phaseFor(phase, index, total).handle.id : parentStageId;

  const info = (message: string, stageId: string | undefined): void => {
    trace.info(message, { stageId });
    onActivity?.(message);
  };
  const recordTerminalActivity = (
    task: Extract<
      WorkflowTaskProgress,
      { readonly status: 'completed' | 'failed' | 'skipped' }
    >,
  ): void => {
    const metadata = formatWorkflowTaskMetadataParts(task);
    const suffix = metadata.length > 0 ? ` · ${metadata.join(' · ')}` : '';
    switch (task.status) {
      case 'completed':
        onActivity?.(`Finished: ${task.label}${suffix}`);
        break;
      case 'failed':
        onActivity?.(`Failed: ${task.label}${suffix} - ${task.error}`);
        break;
      case 'skipped':
        onActivity?.(`Skipped: ${task.label}${suffix}`);
        break;
      default:
        assertNever(task, 'Unhandled terminal workflow task activity');
    }
  };
  const emitTask = (
    task: WorkflowTaskProgress,
    stageId: string | undefined,
  ): void => {
    let projected = projectedTasks.get(task.id);
    if (!projected) {
      projected = {
        logId: `workflow-task-${generateShortId()}`,
        stageId,
        definition: {
          id: task.id,
          label: task.label,
          ...(task.phase !== undefined ? { phase: task.phase } : {}),
        },
        status: task.status,
      };
      projectedTasks.set(task.id, projected);
    } else {
      projected.status = task.status;
    }
    trace.emit({
      type: 'workflow.task',
      logId: projected.logId,
      task,
      stageId: projected.stageId,
    });
  };
  const markPhaseFailed = (
    title: string | undefined,
    index?: number,
    total?: number,
  ): void => {
    if (title) {
      phaseFor(title, index, total).failed = true;
    }
  };

  const project = (event: WorkflowScriptEvent): void => {
    if (closed) return;
    switch (event.type) {
      case 'plan':
        for (const task of event.tasks) {
          emitTask({ ...task, status: 'planned' }, parentStageId);
        }
        break;
      case 'phase':
        currentPhase = event.title;
        phaseFor(event.title, event.index, event.total);
        onActivity?.(`Phase: ${event.title}`);
        break;
      case 'log':
        info(event.message, stageIdFor(currentPhase));
        break;
      case 'agent:start': {
        const phaseTitle = event.phase ?? currentPhase;
        callPhases.set(event.progressId, phaseTitle);
        const stageId = stageIdFor(
          phaseTitle,
          event.phaseIndex,
          event.phaseTotal,
        );
        emitTask(
          {
            id: event.progressId,
            label: event.label,
            ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
            status: 'running',
          },
          stageId,
        );
        onActivity?.(`Running: ${event.label}`);
        break;
      }
      case 'agent:end': {
        // A recorded undefined means the live call started outside any phase;
        // only cached end-only events may use the phase active at replay time.
        const phaseTitle = callPhases.has(event.progressId)
          ? callPhases.get(event.progressId)
          : (event.phase ?? currentPhase);
        callPhases.delete(event.progressId);
        const stageId = stageIdFor(
          phaseTitle,
          event.phaseIndex,
          event.phaseTotal,
        );
        // Cached replays spend nothing, so their lines stay cost-free; live
        // onCost settles before agent:end, so the total here is current.
        const spent =
          event.outcome === 'completed' ||
          event.outcome === 'failed' ||
          event.outcome === 'skipped'
            ? getLiveCostUsd?.()
            : undefined;
        // Live terminal events carry all attempt metadata known by the engine.
        // Cached replays report none because they perform no live attempt.
        switch (event.outcome) {
          case 'failed': {
            markPhaseFailed(phaseTitle, event.phaseIndex, event.phaseTotal);
            const task: WorkflowTaskProgress = {
              id: event.progressId,
              label: event.label,
              ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
              status: 'failed',
              error: event.error,
              ...(event.model !== undefined ? { model: event.model } : {}),
              ...(event.durationMs !== undefined
                ? { durationMs: event.durationMs }
                : {}),
              ...(spent !== undefined ? { totalCostUsd: spent } : {}),
            };
            emitTask(task, stageId);
            recordTerminalActivity(task);
            break;
          }
          case 'cached':
            emitTask(
              {
                id: event.progressId,
                label: event.label,
                ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
                status: 'cached',
              },
              stageId,
            );
            onActivity?.(`Using saved result: ${event.label}`);
            break;
          case 'skipped': {
            const task: WorkflowTaskProgress = {
              id: event.progressId,
              label: event.label,
              ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
              status: 'skipped',
              reason: event.reason,
              ...(event.model !== undefined ? { model: event.model } : {}),
              ...(event.durationMs !== undefined
                ? { durationMs: event.durationMs }
                : {}),
              ...(spent !== undefined ? { totalCostUsd: spent } : {}),
            };
            emitTask(task, stageId);
            recordTerminalActivity(task);
            break;
          }
          case 'completed': {
            const task: WorkflowTaskProgress = {
              id: event.progressId,
              label: event.label,
              ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
              status: 'completed',
              ...(event.model !== undefined ? { model: event.model } : {}),
              durationMs: event.durationMs,
              ...(spent !== undefined ? { totalCostUsd: spent } : {}),
            };
            emitTask(task, stageId);
            recordTerminalActivity(task);
            break;
          }
          default:
            return assertNever(event, 'Unhandled agent:end outcome');
        }
        break;
      }
    }
  };

  try {
    const result = await runPersistedWorkflowScript({
      ...runOptions,
      onEvent: project,
    });
    runOutcome = RUN_OUTCOME.COMPLETED;
    return result;
  } finally {
    closed = true;
    for (const {
      definition: task,
      stageId,
      status,
    } of projectedTasks.values()) {
      if (status === 'planned') {
        const skippedTask: WorkflowTaskProgress = {
          ...task,
          status: 'skipped',
          reason: 'not-reached',
        };
        emitTask(skippedTask, stageId);
        recordTerminalActivity(skippedTask);
      } else if (status === 'running') {
        markPhaseFailed(task.phase);
        const error = 'The workflow ended before this task completed.';
        const totalCostUsd = getLiveCostUsd?.();
        const failedTask: WorkflowTaskProgress = {
          ...task,
          status: 'failed',
          error,
          ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
        };
        emitTask(failedTask, stageId);
        recordTerminalActivity(failedTask);
      }
    }
    for (const phase of phases.values()) {
      phase.handle.end(
        runOutcome === RUN_OUTCOME.COMPLETED && !phase.failed
          ? RUN_OUTCOME.COMPLETED
          : RUN_OUTCOME.FAILED,
      );
    }
  }
}
