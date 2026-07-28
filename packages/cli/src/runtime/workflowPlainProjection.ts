import type { AgentEvent } from '@agent/trace';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  WORKFLOW_TASK_STATUS_LABEL,
  type StreamTabId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import {
  formatWorkflowCallLine,
  formatWorkflowPhaseHeading,
} from '@shared/copy/workflowCall';
import { assertNever } from '@utils/core';

const WORKFLOW_PLAIN_EVENT_TYPES = [
  'stage.start',
  'workflow.task',
  'log',
  'result',
] as const satisfies readonly AgentEvent['type'][];

export interface WorkflowPlainProjectionOptions {
  readonly streamId: StreamTabId;
  readonly writeLine: (line: string) => void;
  readonly beforeWrite?: () => void;
}

function completionLine(
  event: Extract<AgentEvent, { type: 'result' }>,
): string {
  const label = (() => {
    switch (event.outcome) {
      case RUN_OUTCOME.COMPLETED:
        return WORKFLOW_TASK_STATUS_LABEL.completed;
      case RUN_OUTCOME.CANCELLED:
        return WORKFLOW_TASK_STATUS_LABEL.cancelled;
      case RUN_OUTCOME.FAILED:
        return WORKFLOW_TASK_STATUS_LABEL.failed;
      default:
        return assertNever(event.outcome, 'Unhandled workflow run outcome');
    }
  })();
  return `${label}: ${event.agentName}`;
}

/**
 * Project one root workflow stream onto deterministic, spinner-free text.
 * Declared calls are buffered until their phase opens, preserving the visual
 * hierarchy used by the extension and interactive terminal.
 */
export function attachWorkflowPlainProjection(
  events: SessionEventHub,
  options: WorkflowPlainProjectionOptions,
): () => void {
  const openedPhases = new Set<string>();
  const pendingCalls = new Map<string, Map<string, WorkflowCallProgress>>();
  const lastCallLines = new Map<string, string>();

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
    const pending = pendingCalls.get(stageId);
    if (!pending) return;
    for (const [logId, call] of pending) {
      writeCall(logId, call);
    }
    pendingCalls.delete(stageId);
  };
  const flushPendingPhases = (): void => {
    for (const [stageId, pending] of pendingCalls) {
      if (openedPhases.has(stageId)) continue;
      const phaseLabel = pending.values().next().value?.phase;
      if (phaseLabel !== undefined) write(`◆ ${phaseLabel}`);
      for (const [logId, call] of pending) {
        writeCall(logId, call);
      }
    }
    pendingCalls.clear();
  };

  return events.subscribe(
    ({ event }) => {
      switch (event.type) {
        case 'stage.start':
          if (event.kind === 'phase') openPhase(event.id, event);
          break;
        case 'workflow.task':
          if (
            event.task.phase !== undefined &&
            event.stageId !== undefined &&
            !openedPhases.has(event.stageId)
          ) {
            const pending =
              pendingCalls.get(event.stageId) ??
              new Map<string, WorkflowCallProgress>();
            pending.set(event.logId, event.task);
            pendingCalls.set(event.stageId, pending);
          } else {
            writeCall(event.logId, event.task);
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
          if (event.category === 'workflow' && !event.isSubagent) {
            flushPendingPhases();
            write(completionLine(event));
          }
          break;
      }
    },
    {
      scope: 'run',
      streamId: options.streamId,
      types: WORKFLOW_PLAIN_EVENT_TYPES,
    },
  );
}
