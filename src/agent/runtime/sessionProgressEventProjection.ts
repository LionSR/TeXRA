import type { AgentEvent } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas';

import type { SessionFact } from './SessionEventHub';

export type ProjectedProgressEvent = {
  [K in ProgressEvent]: {
    readonly event: K;
    readonly payload: ProgressEventPayloads[K];
  };
}[ProgressEvent];

export function emitProjectedProgressEvent(
  runtimeHost: AgentRuntimeHost,
  projected: ProjectedProgressEvent,
): void {
  runtimeHost.emit(projected.event, projected.payload);
}

export function projectSessionFactToProgressEvent(
  fact: SessionFact,
): ProjectedProgressEvent {
  switch (fact.type) {
    case 'goalStateChanged':
      return { event: 'goalStateChanged', payload: fact.payload };
    case 'inquiryThreadUpdated':
      return { event: 'inquiryThreadUpdated', payload: fact.payload };
    case 'clearMissingOutputs':
      return { event: 'clearMissingOutputs', payload: fact.payload };
    case 'updateQueuedFollowUps':
      return { event: 'updateQueuedFollowUps', payload: fact.payload };
    case 'setActiveStream':
      return { event: 'setActiveStream', payload: fact.payload };
  }
}

export function projectRunFactToProgressEvent(
  streamId: StreamTabId,
  event: AgentEvent,
): ProjectedProgressEvent | undefined {
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
    return {
      event: 'setParentStream',
      payload: {
        childStreamId: event.childStreamId,
        parentStreamId: event.parentStreamId,
      },
    };
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
