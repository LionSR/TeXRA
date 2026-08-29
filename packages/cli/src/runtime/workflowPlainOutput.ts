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
import { getModelLabel } from '@shared/model/modelLabel';
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

/**
 * Headless `texra run` is a log, not a board. A call's pre-start states are
 * already on the TUI card and the workflow board, so the plain projection
 * prints only what a log reader needs: that a call started, and how it ended.
 * `awaitingApproval` stays — a run blocked on a decision is visible nowhere
 * else in a piped log — and a new status has to be classified here to compile.
 */
const WORKFLOW_PLAIN_CALL_LINE = {
  declared: false,
  planned: false,
  queued: false,
  awaitingApproval: true,
  running: true,
  completed: true,
  cached: true,
  skipped: true,
  cancelled: true,
  failed: true,
} as const satisfies Record<WorkflowCallProgress['status'], boolean>;

interface WorkflowPlainOutputOptions {
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

function createWorkflowStreamProjection(
  agentName: string,
  options: WorkflowPlainOutputOptions,
): WorkflowStreamProjection {
  const lastCallLines = new Map<string, string>();
  const runningCalls = new Set<string>();
  let completed = false;

  const write = (line: string): void => {
    options.beforeWrite?.();
    options.writeLine(line);
  };
  const writeCall = (logId: string, call: WorkflowCallProgress): void => {
    if (!WORKFLOW_PLAIN_CALL_LINE[call.status]) return;
    // One `Running:` line per call, written from the first running card: the
    // later cards that only resolve the model or the navigation target say
    // nothing new to a log reader.
    if (call.status === 'running') {
      // Keyed by attempt: a retried call runs again under the same log id.
      const attemptKey = `${logId}#${call.attemptNumber ?? 1}`;
      if (runningCalls.has(attemptKey)) return;
      runningCalls.add(attemptKey);
    }
    // The event carries the canonical model id; the line names it by its
    // runtime label, as the transcript projection does.
    const line = formatWorkflowCallLine(
      'model' in call && call.model !== undefined
        ? { ...call, model: getModelLabel(call.model) }
        : call,
    );
    if (lastCallLines.get(logId) === line) return;
    lastCallLines.set(logId, line);
    write(line);
  };
  const openPhase = (
    phase: Extract<AgentEvent, { type: 'stage.start' }>,
  ): void => {
    write(
      `◆ ${formatWorkflowPhaseHeading({
        phaseLabel: phase.label,
        phaseIndex: phase.index,
        phaseTotal: phase.total,
      })}`,
    );
  };
  const finish = (outcome: RunOutcome): void => {
    if (completed) return;
    completed = true;
    write(completionLine(outcome, agentName));
  };

  return {
    event: (event) => {
      switch (event.type) {
        case 'stage.start':
          if (event.kind === 'phase') openPhase(event);
          break;
        case 'workflow.call':
          // The projection emits a card only once its phase's `stage.start`
          // has been emitted, so the ◆ divider always precedes its rows.
          writeCall(event.logId, event.call);
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
          finish(event.outcome);
          break;
      }
    },
    complete: finish,
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
