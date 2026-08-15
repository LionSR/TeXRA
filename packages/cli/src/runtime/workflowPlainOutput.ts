import type { AgentEvent } from '@agent/trace';
import type { SessionEventHub } from '@agent/runtime';
import {
  MESSAGE_TYPES,
  STREAM_PHASE,
  WORKFLOW_TASK_STATUS_LABEL,
  type RunOutcome,
  type StreamTabId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { formatWorkflowPhaseHeading } from '@shared/copy/workflowCall';
import { assertNever } from '@utils/core';

import { formatCliWorkflowCallLine } from './workflowCallText';

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

/** `RunOutcome` is a subset of the canonical workflow status vocabulary, so the
 *  shared label table is the whole mapping — a new outcome that the table does
 *  not name fails to compile here. */
function completionLine(outcome: RunOutcome, agentName: string): string {
  return `${WORKFLOW_TASK_STATUS_LABEL[outcome]}: ${agentName}`;
}

interface WorkflowStreamProjection {
  readonly event: (event: AgentEvent) => void;
  readonly complete: (outcome: RunOutcome) => void;
}

/**
 * Calls that arrived before their stage opened, grouped by stageId. Owns the
 * get-or-create/take bookkeeping so callers never touch the nested map shape
 * directly.
 */
class PendingCallsByStage {
  private readonly byStage = new Map<
    string,
    Map<string, WorkflowCallProgress>
  >();

  add(stageId: string, logId: string, call: WorkflowCallProgress): void {
    const stage =
      this.byStage.get(stageId) ?? new Map<string, WorkflowCallProgress>();
    stage.set(logId, call);
    this.byStage.set(stageId, stage);
  }

  /** Removes and returns the calls pending for `stageId`, if any. */
  take(stageId: string): Map<string, WorkflowCallProgress> | undefined {
    const stage = this.byStage.get(stageId);
    if (stage) this.byStage.delete(stageId);
    return stage;
  }

  /** Removes and returns every still-pending stage's calls. */
  takeAll(): Array<[string, Map<string, WorkflowCallProgress>]> {
    const all = [...this.byStage];
    this.byStage.clear();
    return all;
  }
}

function createWorkflowStreamProjection(
  agentName: string,
  options: WorkflowPlainOutputOptions,
): WorkflowStreamProjection {
  const openedPhases = new Set<string>();
  const pendingCalls = new PendingCallsByStage();
  const lastCallLines = new Map<string, string>();
  let completed = false;

  const write = (line: string): void => {
    options.beforeWrite?.();
    options.writeLine(line);
  };
  const writeCall = (logId: string, call: WorkflowCallProgress): void => {
    const line = formatCliWorkflowCallLine(call);
    if (lastCallLines.get(logId) === line) return;
    lastCallLines.set(logId, line);
    write(line);
  };
  const openPhase = (
    phase: Extract<AgentEvent, { type: 'stage.start' }>,
  ): void => {
    const stageId = phase.id;
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
    for (const [stageId, pending] of pendingCalls.takeAll()) {
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
          if (event.kind === 'phase') openPhase(event);
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
