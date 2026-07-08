import type { AgentEvent } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@agent/runtime/hostProgressEvents';
import {
  ExtendedTokenUsageStatsSchema,
  ConversationProgressSchema,
  type StorageKey,
  type StreamTabId,
  type UpdateStreamUsagePayload,
} from '@shared/schemas';
import { isObject } from '@utils/core';

import { fromRunFactDomainKey } from './runFactEvents';
import type { SessionEventHub, SessionFact } from './SessionEventHub';

export type ProjectedProgressEvent = {
  [K in ProgressEvent]: {
    readonly event: K;
    readonly payload: ProgressEventPayloads[K];
  };
}[ProgressEvent];

function emitProjectedProgressEvent(
  runtimeHost: AgentRuntimeHost,
  projected: ProjectedProgressEvent,
): void {
  if (
    projected.event === 'removeStream' &&
    runtimeHost.interactions?.handleProgressEvent(
      projected.event,
      projected.payload,
    )
  ) {
    return;
  }
  runtimeHost.emit(projected.event, projected.payload);
}

/**
 * Subscribe a host-owned progress surface to the session fact plane and
 * re-emit the retained progress events that have not yet moved to a native
 * host/session projection.
 */
export function attachSessionProgressEventProjection(
  events: SessionEventHub,
  runtimeHost: AgentRuntimeHost,
): () => void {
  const detachSessionFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'session') return;
      const projected = projectSessionFactToProgressEvent(sessionEvent.event);
      if (projected) emitProjectedProgressEvent(runtimeHost, projected);
    },
    { scope: 'session' },
  );
  const detachRunFacts = subscribeRunFactsAsProgressEvents(
    events,
    (projected) => emitProjectedProgressEvent(runtimeHost, projected),
  );

  return () => {
    detachRunFacts();
    detachSessionFacts();
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse a raw `usage` session-event `data` payload into the typed
 * `updateStreamUsage` progress payload. CLI TUI, legacy host projection, and
 * ProgressBackend all consume this same parser so their accepted usage shapes
 * cannot silently diverge.
 */
export function toUpdateStreamUsagePayload(
  data: unknown,
  fallbackStreamId: StreamTabId,
): UpdateStreamUsagePayload | undefined {
  if (!isObject(data)) return undefined;
  const storageKey = asString(data.storageKey);
  if (!storageKey) return undefined;
  const usage = ExtendedTokenUsageStatsSchema.safeParse(data.usage);
  if (!usage.success) return undefined;

  const streamId = asString(data.streamId) ?? fallbackStreamId;
  const executionId = asString(data.executionId);
  return {
    streamId: streamId as StreamTabId,
    storageKey: storageKey as StorageKey,
    ...(executionId ? { executionId } : {}),
    usage: usage.data,
  };
}

function projectSessionFactToProgressEvent(
  fact: SessionFact,
): ProjectedProgressEvent | undefined {
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

export function projectRunFactToProgressEvent(
  streamId: StreamTabId,
  event: AgentEvent,
): ProjectedProgressEvent | undefined {
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

    const factName = fromRunFactDomainKey(event.key);
    if (!factName || !isObject(event.data)) return undefined;
    return {
      event: factName,
      payload: event.data as ProgressEventPayloads[typeof factName],
    } as ProjectedProgressEvent;
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

const RUN_FACT_PROGRESS_EVENT_TYPES: readonly AgentEvent['type'][] = [
  'domain',
  'run.config',
  'usage',
  'status',
  'stage.start',
  'child.activity',
  'process.output',
];

/**
 * Subscribe to the run-scoped facts that project onto legacy progress
 * events, forwarding each successfully projected event to `onProjected`.
 * Kept for compatibility consumers that still need the legacy progress-event
 * surface, such as headless CLI output.
 */
function subscribeRunFactsAsProgressEvents(
  events: SessionEventHub,
  onProjected: (projected: ProjectedProgressEvent) => void,
): () => void {
  return events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      const projected = projectRunFactToProgressEvent(
        sessionEvent.streamId,
        sessionEvent.event,
      );
      if (projected) onProjected(projected);
    },
    { scope: 'run', types: RUN_FACT_PROGRESS_EVENT_TYPES },
  );
}
