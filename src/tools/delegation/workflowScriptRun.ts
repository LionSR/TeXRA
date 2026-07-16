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
import { RUN_OUTCOME, type RunOutcome } from '@shared/schemas';
import { formatCostUsd } from '@utils/text/stringUtils';

type WorkflowScriptRunWithProgressOptions = Omit<
  PersistedWorkflowScriptRunOptions,
  'onEvent'
> & {
  /** Cumulative live spend across this run's children, for progress lines. */
  readonly getLiveCostUsd?: () => number;
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

/**
 * Sum completed logical-call cost; failed and cancelled attempts are not
 * journaled. Every entry is validated, but entries in `excludeEntries`
 * (journaled by a prior attempt, whose cost that attempt already settled)
 * do not count toward the total.
 */
export function sumCompletedWorkflowJournalCost(
  journal: readonly WorkflowJournalEntry[],
  excludeEntries: ReadonlySet<string> = new Set(),
): number {
  let total = 0;
  for (const entry of journal) {
    const result = AgentFinalResultSchema.safeParse(entry.result);
    if (!result.success) {
      throw new WorkflowJournalCostError(entry.index, {
        cause: result.error,
      });
    }
    if (!excludeEntries.has(workflowJournalEntryCostIdentity(entry))) {
      total += result.data.cost;
    }
  }
  return total;
}

/** Run a durable workflow script and project its progress onto the parent trace. */
export async function runPersistedWorkflowScriptWithProgress(
  trace: AgentTrace,
  options: WorkflowScriptRunWithProgressOptions,
): Promise<WorkflowScriptRunResult> {
  const { getLiveCostUsd, ...runOptions } = options;
  const parentStageId = trace.activeStageId();
  const phases = new Map<string, PhaseStage>();
  const callPhases = new Map<number, string | undefined>();
  let currentPhase: string | undefined;
  let closed = false;
  let runOutcome: RunOutcome = RUN_OUTCOME.FAILED;

  const phaseFor = (title: string): PhaseStage => {
    const existing = phases.get(title);
    if (existing) return existing;
    const phase = {
      handle: trace.openStage(title, {
        kind: 'phase',
        parentId: parentStageId,
      }),
      failed: false,
    };
    phases.set(title, phase);
    return phase;
  };

  const stageIdFor = (phase: string | undefined): string | undefined =>
    phase ? phaseFor(phase).handle.id : parentStageId;

  const project = (event: WorkflowScriptEvent): void => {
    if (closed) return;
    switch (event.type) {
      case 'phase':
        currentPhase = event.title;
        phaseFor(event.title);
        break;
      case 'log':
        trace.info(event.message, { stageId: stageIdFor(currentPhase) });
        break;
      case 'agent:start': {
        const phaseTitle = event.phase ?? currentPhase;
        callPhases.set(event.index, phaseTitle);
        trace.info(`Running: ${event.label}`, {
          stageId: stageIdFor(phaseTitle),
        });
        break;
      }
      case 'agent:end': {
        // A recorded undefined means the live call started outside any phase;
        // only cached end-only events may use the phase active at replay time.
        const phaseTitle = callPhases.has(event.index)
          ? callPhases.get(event.index)
          : (event.phase ?? currentPhase);
        callPhases.delete(event.index);
        const stageId = stageIdFor(phaseTitle);
        // Cached replays spend nothing, so their lines stay cost-free; live
        // onCost settles before agent:end, so the total here is current.
        const spent = event.cached ? undefined : getLiveCostUsd?.();
        const total =
          spent === undefined ? '' : ` (${formatCostUsd(spent)} total)`;
        if (event.error) {
          if (phaseTitle) phaseFor(phaseTitle).failed = true;
          trace.error(`Failed: ${event.label} - ${event.error}${total}`, {
            stageId,
          });
        } else if (event.cached) {
          trace.info(`Using saved result: ${event.label}`, { stageId });
        } else {
          trace.info(`Finished: ${event.label}${total}`, { stageId });
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
    for (const phase of phases.values()) {
      phase.handle.end(
        runOutcome === RUN_OUTCOME.COMPLETED && !phase.failed
          ? RUN_OUTCOME.COMPLETED
          : RUN_OUTCOME.FAILED,
      );
    }
  }
}
