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
import { formatWorkflowTaskLine } from '@shared/copy/workflowTask';
import { assertNever, generateShortId } from '@utils/core';

type WorkflowScriptRunWithProgressOptions = Omit<
  PersistedWorkflowScriptRunOptions,
  'onEvent'
> & {
  /**
   * One call's own live spend, by the engine's 0-based call index. Progress
   * lines are per task, so they report per call; the run total is settled
   * separately onto the parent's usage. Undefined for a call that performed no
   * live attempt (a journal replay), which therefore reports no cost at all.
   */
  readonly getCallCostUsd?: (index: number) => number | undefined;
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

interface LiveCall {
  readonly phase: string | undefined;
  /** 0-based engine call index — the key this call's cost is observed under. */
  readonly index: number;
}

interface ProjectedWorkflowTask {
  readonly logId: string;
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
  const { getCallCostUsd, onActivity, ...runOptions } = options;
  const parentStageId = trace.activeStageId();
  const phases = new Map<string, PhaseStage>();
  const phaseStageIds = new Map<string, string>();
  /**
   * What the run knows about a call it has started but not yet settled: the
   * phase it began in, and the engine call index its cost is billed under.
   * Entries survive exactly until `agent:end`, so a call still present when the
   * run tears down is one that never finished.
   */
  const liveCalls = new Map<WorkflowScriptProgressId, LiveCall>();
  const projectedTasks = new Map<
    WorkflowScriptProgressId,
    ProjectedWorkflowTask
  >();
  let currentPhase: string | undefined;
  let closed = false;
  let runOutcome: RunOutcome = RUN_OUTCOME.FAILED;

  /**
   * Stable stage id for a phase title, minted before the stage opens. A
   * declared task can name the group it belongs to from the moment it is
   * planned, while `stage.start` — which settles the divider's print order the
   * instant it is emitted — still waits until the run actually reaches the
   * phase, so a divider never prints above its own task rows.
   */
  const phaseStageIdFor = (title: string): string => {
    const existing = phaseStageIds.get(title);
    if (existing) return existing;
    const id = generateShortId();
    phaseStageIds.set(title, id);
    return id;
  };

  const phaseFor = (
    title: string,
    index?: number,
    total?: number,
  ): PhaseStage => {
    const existing = phases.get(title);
    if (existing) return existing;
    const phase = {
      handle: trace.openStage(title, {
        id: phaseStageIdFor(title),
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

  /**
   * Open a phase stage once the run reaches it and answer the stage rows
   * emitted from there belong to. Callers that only need the phase opened
   * ignore the return: `emitTask` resolves a card's group itself.
   */
  const openPhaseStage = (
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
    onActivity?.(formatWorkflowTaskLine(task));
  };
  /**
   * The phase recorded on a task's first emission is the single owner of
   * "which phase is this task in", and it stamps both halves of that answer:
   * the `stageId` its card is grouped under, and the `phase` on the emitted
   * payload that hosts fold `done/total` by. A later update carrying the phase
   * active at call time never overrides it, so the group and the fold cannot
   * drift apart, and the same card cannot land in two groups — host progress
   * trees classify a card once and cannot move it afterwards.
   */
  const emitTask = (task: WorkflowTaskProgress): void => {
    let projected = projectedTasks.get(task.id);
    if (!projected) {
      projected = {
        logId: `workflow-task-${generateShortId()}`,
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
    const phase = projected.definition.phase;
    trace.emit({
      type: 'workflow.task',
      logId: projected.logId,
      task: { ...task, phase },
      stageId: phase === undefined ? parentStageId : phaseStageIdFor(phase),
    });
  };
  const recordedTaskPhase = (
    task: Pick<WorkflowTaskProgress, 'id' | 'phase'>,
  ): string | undefined => {
    const projected = projectedTasks.get(task.id);
    return projected ? projected.definition.phase : task.phase;
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
          emitTask({ ...task, status: 'planned' });
        }
        break;
      case 'phase':
        currentPhase = event.title;
        phaseFor(event.title, event.index, event.total);
        onActivity?.(`Phase: ${event.title}`);
        break;
      case 'log':
        info(event.message, openPhaseStage(currentPhase));
        break;
      case 'agent:start': {
        const phaseTitle = event.phase ?? currentPhase;
        liveCalls.set(event.progressId, {
          phase: phaseTitle,
          index: event.index,
        });
        // Open the phase the moment the run reaches it; `emitTask` resolves
        // the card's group on its own from the task's recorded phase.
        openPhaseStage(phaseTitle, event.phaseIndex, event.phaseTotal);
        emitTask({
          id: event.progressId,
          label: event.label,
          ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
          status: 'running',
        });
        onActivity?.(`Running: ${event.label}`);
        break;
      }
      case 'agent:end': {
        // A recorded undefined means the live call started outside any phase;
        // only cached end-only events may use the phase active at replay time.
        const liveCall = liveCalls.get(event.progressId);
        const phaseTitle = liveCall
          ? liveCall.phase
          : (event.phase ?? currentPhase);
        liveCalls.delete(event.progressId);
        // A cached replay has no agent:start, so this is where its phase opens.
        openPhaseStage(phaseTitle, event.phaseIndex, event.phaseTotal);
        // Cached replays spend nothing, so their lines stay cost-free; live
        // onCost settles before agent:end, so this call's spend is final here.
        // Retried attempts share the engine index, so a retried call bills the
        // work it discarded — the same reading the run's own total takes.
        const spent =
          event.outcome === 'completed' ||
          event.outcome === 'failed' ||
          event.outcome === 'skipped'
            ? getCallCostUsd?.(event.index)
            : undefined;
        // Live terminal events carry all attempt metadata known by the engine.
        // Cached replays report none because they perform no live attempt.
        const terminalMetadata = (source: {
          readonly model?: string;
          readonly durationMs?: number;
        }) => ({
          ...(source.model !== undefined ? { model: source.model } : {}),
          ...(source.durationMs !== undefined
            ? { durationMs: source.durationMs }
            : {}),
          ...(spent !== undefined ? { totalCostUsd: spent } : {}),
        });
        switch (event.outcome) {
          case 'failed': {
            const task: WorkflowTaskProgress = {
              id: event.progressId,
              label: event.label,
              ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
              status: 'failed',
              error: event.error,
              ...terminalMetadata(event),
            };
            markPhaseFailed(
              recordedTaskPhase(task),
              event.phaseIndex,
              event.phaseTotal,
            );
            emitTask(task);
            recordTerminalActivity(task);
            break;
          }
          case 'cached':
            emitTask({
              id: event.progressId,
              label: event.label,
              ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
              status: 'cached',
            });
            onActivity?.(`Using saved result: ${event.label}`);
            break;
          case 'skipped': {
            const task: WorkflowTaskProgress = {
              id: event.progressId,
              label: event.label,
              ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
              status: 'skipped',
              reason: event.reason,
              ...terminalMetadata(event),
            };
            emitTask(task);
            recordTerminalActivity(task);
            break;
          }
          case 'completed': {
            const task: WorkflowTaskProgress = {
              id: event.progressId,
              label: event.label,
              ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
              status: 'completed',
              ...terminalMetadata(event),
            };
            emitTask(task);
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
    for (const { definition: task, status } of projectedTasks.values()) {
      if (status === 'planned') {
        // Open the declared phase the run never reached so its skipped cards
        // still land under a header; the loop below then closes it.
        openPhaseStage(task.phase);
        const skippedTask: WorkflowTaskProgress = {
          ...task,
          status: 'skipped',
          reason: 'not-reached',
        };
        emitTask(skippedTask);
        recordTerminalActivity(skippedTask);
      } else if (status === 'running') {
        markPhaseFailed(task.phase);
        const error = 'The workflow ended before this task completed.';
        // Never settled, so its call is still live and still names its index.
        const index = liveCalls.get(task.id)?.index;
        const totalCostUsd =
          index === undefined ? undefined : getCallCostUsd?.(index);
        const failedTask: WorkflowTaskProgress = {
          ...task,
          status: 'failed',
          error,
          ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
        };
        emitTask(failedTask);
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
