import type { AgentEvent } from '@agent/trace';
import { toUpdateStreamUsagePayload } from '@agent/runtime/runFactUsage';
import type {
  SessionEventHub,
  SessionFact,
} from '@agent/runtime/SessionEventHub';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { ConversationProgressSchema, type StreamTabId } from '@shared/schemas';
import type {
  CliProgressEvent,
  CliProgressEventPayloads,
  CliProgressSink,
} from './cliProgressEvents';

type CliProjectedProgressEvent = {
  [K in CliProgressEvent]: {
    readonly event: K;
    readonly payload: CliProgressEventPayloads[K];
  };
}[CliProgressEvent];

const CLI_RUN_FACT_PROGRESS_EVENT_TYPES: readonly AgentEvent['type'][] = [
  'domain',
  'updateTodos',
  'updatePlan',
  'addOutputFiles',
  'updateMissingOutputs',
  'updateCompileFailures',
  'goalPaused',
  'run.config',
  'usage',
  'status',
  'stage.start',
  'child.activity',
  'process.output',
];

/**
 * Project session facts onto the frozen host-progress vocabulary for headless
 * CLI public output. `followUpSent` is intentionally session-local.
 */
function projectCliSessionFact(
  fact: SessionFact,
): CliProjectedProgressEvent | undefined {
  switch (fact.type) {
    case 'goalStateChanged':
      return { event: 'goalStateChanged', payload: fact.payload };
    case 'inquiryThreadUpdated':
      return { event: 'inquiryThreadUpdated', payload: fact.payload };
    case 'clearMissingOutputs':
      return { event: 'clearMissingOutputs', payload: fact.payload };
    case 'updateQueuedFollowUps':
      return { event: 'updateQueuedFollowUps', payload: fact.payload };
    case 'followUpSent':
      return undefined;
    case 'setActiveStream':
      return { event: 'setActiveStream', payload: fact.payload };
    case 'updateStreamDescription':
      return { event: 'updateStreamDescription', payload: fact.payload };
    case 'updateStreamStatus':
      return { event: 'updateStreamStatus', payload: fact.payload };
    case 'setParentStream':
      return { event: 'setParentStream', payload: fact.payload };
    case 'removeStream':
      return { event: 'removeStream', payload: fact.payload };
  }
}

function projectCliRunFact(
  streamId: StreamTabId,
  event: AgentEvent,
): CliProjectedProgressEvent | undefined {
  if (event.type === 'usage') {
    const payload = toUpdateStreamUsagePayload(event.data, streamId);
    return payload ? { event: 'updateStreamUsage', payload } : undefined;
  }

  if (event.type === 'run.config') {
    return {
      event: 'setTaskState',
      payload: {
        streamId: event.streamId,
        executionId: event.executionId,
        taskState: agentConfigToTaskState(event.config),
      },
    };
  }

  if (event.type === 'status') {
    return {
      event: 'updateStreamStatus',
      payload: {
        streamId: event.streamId,
        status: event.phase,
        cause: event.cause,
        ...(event.previousPhase ? { previousStatus: event.previousPhase } : {}),
        ...(event.substate ? { substate: event.substate } : {}),
      },
    };
  }

  if (event.type === 'domain') {
    if (event.key === 'conversationProgress') {
      const progress = ConversationProgressSchema.safeParse(event.data);
      if (!progress.success) return undefined;
      return {
        event: 'updateConversationProgress',
        payload: {
          streamId,
          progress: progress.data,
        },
      };
    }
    return undefined;
  }

  if (event.type === 'updateTodos') {
    return {
      event: 'updateTodos',
      payload: { streamId: event.streamId, todos: event.todos },
    };
  }

  if (event.type === 'updatePlan') {
    return {
      event: 'updatePlan',
      payload: { streamId: event.streamId, plan: event.plan },
    };
  }

  if (event.type === 'addOutputFiles') {
    return {
      event: 'addOutputFiles',
      payload: {
        streamId: event.streamId,
        ...(event.executionId ? { executionId: event.executionId } : {}),
        filesByRound: event.filesByRound,
      },
    };
  }

  if (event.type === 'updateMissingOutputs') {
    return {
      event: 'updateMissingOutputs',
      payload: {
        streamId: event.streamId,
        ...(event.executionId ? { executionId: event.executionId } : {}),
        filesByRound: event.filesByRound,
      },
    };
  }

  if (event.type === 'updateCompileFailures') {
    return {
      event: 'updateCompileFailures',
      payload: {
        streamId: event.streamId,
        ...(event.executionId ? { executionId: event.executionId } : {}),
        filesByRound: event.filesByRound,
      },
    };
  }

  if (event.type === 'goalPaused') {
    return { event: 'goalPaused', payload: { streamId: event.streamId } };
  }

  if (event.type === 'stage.start') {
    if (event.kind !== 'round') return undefined;
    return {
      event: 'updateRoundStage',
      payload: {
        streamId,
        roundStage: {
          index: event.index ?? 0,
          ...(event.total !== undefined && event.total > 0
            ? { total: event.total }
            : {}),
        },
      },
    };
  }

  if (event.type === 'child.activity') {
    if (event.kind === 'subagents') {
      return {
        event: 'updateActiveSubagents',
        payload: {
          parentStreamId: event.parentStreamId,
          children: [...event.children],
        },
      };
    }
    if (event.kind === 'processes') {
      return {
        event: 'updateActiveProcesses',
        payload: {
          parentStreamId: event.parentStreamId,
          processes: [...event.processes],
        },
      };
    }
  }

  if (event.type === 'process.output') {
    return {
      event: 'updateProcessOutput',
      payload: {
        parentStreamId: event.parentStreamId,
        executionId: event.executionId,
        stdout: event.stdout,
        stderr: event.stderr,
      },
    };
  }

  return undefined;
}

function emitProjectedProgressEvent(
  runtimeHost: CliProgressSink,
  projected: CliProjectedProgressEvent,
): void {
  runtimeHost.emit(projected.event, projected.payload);
}

/**
 * Headless CLI compatibility adapter. Public CLI output still speaks the
 * frozen host progress-event vocabulary, so this boundary alone re-emits
 * session facts through `runtimeHost.emit`.
 */
export function attachCliSessionProgressProjection(
  events: SessionEventHub,
  runtimeHost: CliProgressSink,
): () => void {
  const detachSessionFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'session') return;
      const projected = projectCliSessionFact(sessionEvent.event);
      if (projected) emitProjectedProgressEvent(runtimeHost, projected);
    },
    { scope: 'session' },
  );
  const detachRunFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      const projected = projectCliRunFact(
        sessionEvent.streamId,
        sessionEvent.event,
      );
      if (projected) emitProjectedProgressEvent(runtimeHost, projected);
    },
    { scope: 'run', types: CLI_RUN_FACT_PROGRESS_EVENT_TYPES },
  );

  return () => {
    detachRunFacts();
    detachSessionFacts();
  };
}
