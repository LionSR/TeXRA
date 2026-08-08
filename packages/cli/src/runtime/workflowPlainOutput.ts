import type { AgentEvent } from '@agent/trace';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_PHASE,
  WORKFLOW_TASK_STATUS_LABEL,
  type RunOutcome,
  type StreamTabId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import {
  formatWorkflowCallLine,
  formatWorkflowPhaseHeading,
} from '@shared/copy/workflowCall';
import { assertNever } from '@utils/core';

const WORKFLOW_PLAIN_EVENT_TYPES = [
  'run.start',
  'stage.start',
  'workflow.call',
  'log',
  'result',
] as const satisfies readonly AgentEvent['type'][];

export interface WorkflowPlainOutputOptions {
  readonly writeLine: (line: string) => void;
  readonly beforeWrite?: () => void;
}

function completionLine(outcome: RunOutcome, agentName: string): string {
  const label = (() => {
    switch (outcome) {
      case RUN_OUTCOME.COMPLETED:
        return WORKFLOW_TASK_STATUS_LABEL.completed;
      case RUN_OUTCOME.CANCELLED:
        return WORKFLOW_TASK_STATUS_LABEL.cancelled;
      case RUN_OUTCOME.FAILED:
        return WORKFLOW_TASK_STATUS_LABEL.failed;
      default:
        return assertNever(outcome, 'Unhandled workflow run outcome');
    }
  })();
  return `${label}: ${agentName}`;
}

interface WorkflowStreamProjection {
  readonly event: (event: AgentEvent) => void;
  readonly complete: (outcome: RunOutcome) => void;
}

/** Calls that arrived before their stage's phase heading opened, held per stage. */
class PendingWorkflowCalls {
  private readonly byStage = new Map<string, Map<string, WorkflowCallProgress>>();

  add(stageId: string, logId: string, call: WorkflowCallProgress): void {
    let calls = this.byStage.get(stageId);
    if (!calls) {
      calls = new Map();
      this.byStage.set(stageId, calls);
    }
    calls.set(logId, call);
  }

  /** Removes and returns a stage's pending calls, or `undefined` if none. */
  take(stageId: string): ReadonlyMap<string, WorkflowCallProgress> | undefined {
    const calls = this.byStage.get(stageId);
    this.byStage.delete(stageId);
    return calls;
  }

  /** Removes and returns every stage's pending calls, in stage-insertion order. */
  drain(): Array<[string, ReadonlyMap<string, WorkflowCallProgress>]> {
    const entries = [...this.byStage];
    this.byStage.clear();
    return entries;
  }
}

function createWorkflowStreamProjection(
  agentName: string,
  options: WorkflowPlainOutputOptions,
): WorkflowStreamProjection {
  const openedPhases = new Set<string>();
  const pendingCalls = new PendingWorkflowCalls();
  const lastCallLines = new Map<string, string>();
  let completed = false;

  const write = (line: string): void => {
    options.beforeWrite?.();
    options.writeLine(line);
  };
  const writeCall = (logId: string, call: WorkflowCallProgress): void => {
    const line = formatWorkflowCallLine(call);
    if (lastCallLines.get(logId) === line) return;
    lastCallLines.set(logId, line);
    write(line);
  };
  const openPhase = (
    stageId: string,
    phase: Extract<AgentEvent, { type: 'stage.start' }>,
  ): void => {
    if (openedPhases.has(stageId)) return;
    openedPhases.add(stageId);
    write(
      `◆ ${formatWorkflowPhaseHeading({
        phaseLabel: phase.label,
        phaseIndex: phase.index,
        phaseTotal: phase.total,
      })}`,
    );
    const pending = pendingCalls.take(stageId);
    if (!pending) return;
    for (const [logId, call] of pending) {
      writeCall(logId, call);
    }
  };
  const flushPendingPhases = (): void => {
    for (const [stageId, pending] of pendingCalls.drain()) {
      if (openedPhases.has(stageId)) continue;
      const phaseLabel = pending.values().next().value?.phase;
      if (phaseLabel !== undefined) write(`◆ ${phaseLabel}`);
      for (const [logId, call] of pending) {
        writeCall(logId, call);
      }
    }
  };

  return {
    event: (event) => {
      switch (event.type) {
        case 'stage.start':
          if (event.kind === 'phase') openPhase(event.id, event);
          break;
        case 'workflow.call':
          if (
            event.call.phase !== undefined &&
            event.stageId !== undefined &&
            !openedPhases.has(event.stageId)
          ) {
            pendingCalls.add(event.stageId, event.logId, event.call);
          } else {
            writeCall(event.logId, event.call);
          }
          break;
        case 'log':
          if (
            event.level !== 'debug' &&
            event.verbose !== false &&
            event.messageType !== MESSAGE_TYPES.INTERNAL &&
            event.messageType !== MESSAGE_TYPES.WORKFLOW_TASK &&
            event.message.trim().length > 0
          ) {
            write(event.message);
          }
          break;
        case 'result':
          if (!completed) {
            completed = true;
            flushPendingPhases();
            write(completionLine(event.outcome, agentName));
          }
          break;
      }
    },
    complete: (outcome) => {
      if (completed) return;
      completed = true;
      flushPendingPhases();
      write(completionLine(outcome, agentName));
    },
  };
}

/**
 * Project every detached workflow-script stream onto deterministic,
 * spinner-free text. The `run.start` identity is the source of truth (only
 * `kind: 'multiAgentWorkflow'` streams project here): ordinary workflow
 * agents retain their usual renderer.
 */
export function attachWorkflowPlainOutput(
  events: SessionEventHub,
  options: WorkflowPlainOutputOptions,
): () => void {
  const projections = new Map<StreamTabId, WorkflowStreamProjection>();
  const detachRunEvents = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      const { streamId, event } = sessionEvent;
      if (event.type === 'run.start') {
        if (event.identity.kind === 'multiAgentWorkflow') {
          projections.set(
            streamId,
            createWorkflowStreamProjection(
              event.identity.workflowName,
              options,
            ),
          );
        }
        return;
      }
      projections.get(streamId)?.event(event);
    },
    {
      scope: 'run',
      types: WORKFLOW_PLAIN_EVENT_TYPES,
    },
  );
  const detachSessionEvents = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'session') return;
      const { event } = sessionEvent;
      if (event.type === 'removeStream') {
        projections.delete(event.payload.streamId);
        return;
      }
      if (event.type !== 'status') return;
      const projection = projections.get(event.streamId);
      if (!projection) return;
      switch (event.phase) {
        case STREAM_PHASE.COMPLETED:
        case STREAM_PHASE.CANCELLED:
        case STREAM_PHASE.FAILED:
          projection.complete(event.phase);
          break;
        case STREAM_PHASE.RUNNING:
        case STREAM_PHASE.WAITING:
          break;
        default:
          assertNever(event.phase, 'Unhandled workflow stream status');
      }
    },
    { scope: 'session' },
  );

  return () => {
    detachSessionEvents();
    detachRunEvents();
    projections.clear();
  };
}
