import { RUN_FACT_EVENT_TYPES, type AgentEvent } from '@agent/trace';
import type {
  SessionEventHub,
  SessionFact,
} from '@agent/runtime/SessionEventHub';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import type { StreamTabId } from '@shared/schemas';
import { assertNever } from '@utils/core';
import { writeNdjsonStdout } from './logSinks';
import type {
  CliNdjsonProgressEvent,
  CliNdjsonProgressEventPayloads,
} from './cliNdjsonProgressEvents';

type CliProjectedNdjsonProgressEvent = {
  [K in CliNdjsonProgressEvent]: {
    readonly event: K;
    readonly payload: CliNdjsonProgressEventPayloads[K];
  };
}[CliNdjsonProgressEvent];

export type CliNdjsonProgressRecordWriter = (record: CliNdjsonRecord) => void;

/**
 * Project session facts onto the frozen NDJSON progress-event vocabulary.
 * `followUpSent` is intentionally session-local.
 */
function projectCliSessionFact(
  fact: SessionFact,
): CliProjectedNdjsonProgressEvent | undefined {
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
  assertNever(fact, 'Unhandled CLI NDJSON session fact');
}

function projectCliRunFact(
  streamId: StreamTabId,
  event: AgentEvent,
): CliProjectedNdjsonProgressEvent | undefined {
  switch (event.type) {
    case 'usage':
      return { event: 'updateStreamUsage', payload: event.payload };
    case 'run.config':
      return {
        event: 'setTaskState',
        payload: {
          streamId: event.streamId,
          executionId: event.executionId,
          taskState: agentConfigToTaskState(event.config),
        },
      };
    case 'conversation.progress':
      return {
        event: 'updateConversationProgress',
        payload: { streamId, progress: event.progress },
      };
    case 'updateTodos':
      return {
        event: 'updateTodos',
        payload: { streamId: event.streamId, todos: event.todos },
      };
    case 'updatePlan':
      return {
        event: 'updatePlan',
        payload: { streamId: event.streamId, plan: event.plan },
      };
    case 'addOutputFiles':
      return {
        event: 'addOutputFiles',
        payload: {
          streamId: event.streamId,
          ...(event.executionId ? { executionId: event.executionId } : {}),
          filesByRound: event.filesByRound,
        },
      };
    case 'updateMissingOutputs':
      return {
        event: 'updateMissingOutputs',
        payload: {
          streamId: event.streamId,
          ...(event.executionId ? { executionId: event.executionId } : {}),
          filesByRound: event.filesByRound,
        },
      };
    case 'updateCompileFailures':
      return {
        event: 'updateCompileFailures',
        payload: {
          streamId: event.streamId,
          ...(event.executionId ? { executionId: event.executionId } : {}),
          filesByRound: event.filesByRound,
        },
      };
    case 'goalPaused':
      return { event: 'goalPaused', payload: { streamId: event.streamId } };
    case 'stage.start':
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
    case 'child.activity':
      return {
        event: 'updateActiveSubagents',
        payload: {
          parentStreamId: event.parentStreamId,
          children: [...event.items],
        },
      };
    default:
      return undefined;
  }
}

/**
 * Headless CLI compatibility adapter. Public NDJSON output still speaks the
 * frozen progress-event vocabulary inside `kind: "progress"` records, so this
 * boundary alone projects session/run facts into that public wire shape.
 */
export function attachCliSessionProgressProjection(
  events: SessionEventHub,
  writeRecord: CliNdjsonProgressRecordWriter = writeNdjsonStdout,
): () => void {
  function emitProjected(projected: CliProjectedNdjsonProgressEvent): void {
    writeRecord({
      kind: 'progress',
      event: projected.event,
      ts: new Date().toISOString(),
      payload: projected.payload,
    });
  }

  const detachSessionFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'session') return;
      const projected = projectCliSessionFact(sessionEvent.event);
      if (projected) emitProjected(projected);
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
      if (projected) emitProjected(projected);
    },
    { scope: 'run', types: RUN_FACT_EVENT_TYPES },
  );

  return () => {
    detachRunFacts();
    detachSessionFacts();
  };
}
