// Local imports - agent runtime
import type { AgentTrace, StageHandle } from '@agent/trace';
import {
  runPersistedWorkflowScript,
  type PersistedWorkflowScriptRunOptions,
  type WorkflowJournalEntry,
  type WorkflowScriptEvent,
  type WorkflowScriptRunResult,
} from '@agent/workflowScript';
import { AgentFinalResultSchema } from '@agent/runtime/AgentFinalResult';
import {
  RUN_OUTCOME,
  type RunOutcome,
  type WorkflowTaskProgress,
} from '@shared/schemas';
import { generateShortId } from '@utils/core';
import { formatCompactDuration, formatCostUsd } from '@utils/text/stringUtils';

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
  const callPhases = new Map<string, string | undefined>();
  const taskLogIds = new Map<string, string>();
  const taskStates = new Map<string, WorkflowTaskProgress['status']>();
  const taskDefinitions = new Map<
    string,
    Pick<WorkflowTaskProgress, 'id' | 'label' | 'phase'>
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
  const emitTask = (
    task: WorkflowTaskProgress,
    stageId: string | undefined,
  ): void => {
    let logId = taskLogIds.get(task.id);
    if (!logId) {
      logId = `workflow-task-${generateShortId()}`;
      taskLogIds.set(task.id, logId);
    }
    taskStates.set(task.id, task.status);
    taskDefinitions.set(task.id, {
      id: task.id,
      label: task.label,
      ...(task.phase !== undefined ? { phase: task.phase } : {}),
    });
    trace.emit({
      type: 'workflow.task',
      logId,
      task,
      stageId,
    });
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
        callPhases.set(event.taskId, phaseTitle);
        const stageId = stageIdFor(
          phaseTitle,
          event.phaseIndex,
          event.phaseTotal,
        );
        emitTask(
          {
            id: event.taskId,
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
        const phaseTitle = callPhases.has(event.taskId)
          ? callPhases.get(event.taskId)
          : (event.phase ?? currentPhase);
        callPhases.delete(event.taskId);
        const stageId = stageIdFor(
          phaseTitle,
          event.phaseIndex,
          event.phaseTotal,
        );
        // Cached replays spend nothing, so their lines stay cost-free; live
        // onCost settles before agent:end, so the total here is current.
        const spent =
          event.outcome === 'completed' || event.outcome === 'failed'
            ? getLiveCostUsd?.()
            : undefined;
        const total =
          spent === undefined ? '' : ` (${formatCostUsd(spent)} total)`;
        // Live calls carry the resolved child model plus host-measured wall
        // time; the duration rides alongside the model so it never appears as
        // a bare orphan. Cached replays report neither, so the suffix is empty.
        switch (event.outcome) {
          case 'failed': {
            if (phaseTitle) {
              phaseFor(phaseTitle, event.phaseIndex, event.phaseTotal).failed =
                true;
            }
            const task: WorkflowTaskProgress = {
              id: event.taskId,
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
            const duration =
              event.durationMs === undefined
                ? ''
                : ` · ${formatCompactDuration(event.durationMs)}`;
            const metaSuffix =
              event.model === undefined ? '' : ` · ${event.model}${duration}`;
            onActivity?.(
              `Failed: ${event.label}${metaSuffix} - ${event.error}${total}`,
            );
            break;
          }
          case 'cached':
            emitTask(
              {
                id: event.taskId,
                label: event.label,
                ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
                status: 'cached',
              },
              stageId,
            );
            onActivity?.(`Using saved result: ${event.label}`);
            break;
          case 'skipped':
            emitTask(
              {
                id: event.taskId,
                label: event.label,
                ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
                status: 'skipped',
                reason: 'user',
              },
              stageId,
            );
            onActivity?.(`Skipped: ${event.label}`);
            break;
          case 'completed': {
            emitTask(
              {
                id: event.taskId,
                label: event.label,
                ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
                status: 'completed',
                ...(event.model !== undefined ? { model: event.model } : {}),
                durationMs: event.durationMs,
                ...(spent !== undefined ? { totalCostUsd: spent } : {}),
              },
              stageId,
            );
            const duration = ` · ${formatCompactDuration(event.durationMs)}`;
            const metaSuffix =
              event.model === undefined ? '' : ` · ${event.model}${duration}`;
            onActivity?.(`Finished: ${event.label}${metaSuffix}${total}`);
            break;
          }
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
    for (const [taskId, status] of taskStates) {
      const task = taskDefinitions.get(taskId);
      if (!task) continue;
      if (status === 'planned') {
        emitTask(
          {
            ...task,
            status: 'skipped',
            reason: 'not-reached',
          },
          parentStageId,
        );
      } else if (status === 'running') {
        emitTask(
          {
            ...task,
            status: 'failed',
            error: 'The workflow ended before this task completed.',
          },
          task.phase ? phases.get(task.phase)?.handle.id : parentStageId,
        );
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
