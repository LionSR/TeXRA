// Local imports - agent runtime
import type { AgentTrace, StageHandle } from '@agent/trace';
import {
  runPersistedWorkflowScript,
  type PersistedWorkflowScriptRunOptions,
  type WorkflowScriptEvent,
  type WorkflowScriptRunResult,
} from '@agent/workflowScript';
import { RUN_OUTCOME, type RunOutcome } from '@shared/schemas';

type WorkflowScriptRunWithProgressOptions = Omit<
  PersistedWorkflowScriptRunOptions,
  'onEvent'
>;

interface PhaseStage {
  readonly handle: StageHandle;
  failed: boolean;
}

/** Run a durable workflow script and project its progress onto the parent trace. */
export async function runPersistedWorkflowScriptWithProgress(
  trace: AgentTrace,
  options: WorkflowScriptRunWithProgressOptions,
): Promise<WorkflowScriptRunResult> {
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
        const phaseTitle = callPhases.has(event.index)
          ? callPhases.get(event.index)
          : (event.phase ?? currentPhase);
        callPhases.delete(event.index);
        const stageId = stageIdFor(phaseTitle);
        if (event.error) {
          if (phaseTitle) phaseFor(phaseTitle).failed = true;
          trace.error(`Failed: ${event.label} - ${event.error}`, { stageId });
        } else if (event.cached) {
          trace.info(`Using saved result: ${event.label}`, { stageId });
        } else {
          trace.info(`Finished: ${event.label}`, { stageId });
        }
        break;
      }
    }
  };

  try {
    const result = await runPersistedWorkflowScript({
      ...options,
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
