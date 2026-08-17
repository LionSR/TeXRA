import { RUN_FACT_EVENT_TYPES, type AgentEvent } from '@agent/trace';
import {
  agentConfigToTaskState,
  type SessionEventHub,
  type SessionFact,
} from '@agent/runtime';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';
import { roundStageFromStageStart } from '@shared/streams/stage';
import { assertNever } from '@utils/core';
import { writeNdjsonStdout } from './logSinks';
import type {
  CliNdjsonActiveChildRow,
  CliNdjsonProgressEvent,
  CliNdjsonProgressEventPayloads,
} from './cliNdjsonProgressEvents';

/**
 * Project one roster row onto the frozen public shape (proposal gate G): the
 * `identity` struct is internal — public NDJSON keeps the pre-consolidation
 * `kind`/`toolName`/`childStreamId` encoding. `delegate_multi_agents` is the
 * historical toolName of a workflow-script child.
 */
function projectCliActiveChildRow(
  item: ActiveChildInfo,
): CliNdjsonActiveChildRow {
  const {
    identity,
    childStreamId,
    resumeEligible: _resumeEligible,
    ...rest
  } = item;
  const toolName =
    identity.kind === 'multiAgentWorkflow'
      ? 'delegate_multi_agents'
      : identity.tool;
  return {
    kind: identity.kind === 'process' ? 'process' : 'subagent',
    ...rest,
    ...(toolName !== undefined ? { toolName } : {}),
    ...(identity.kind === 'process' ? {} : { childStreamId }),
  };
}

type CliProjectedNdjsonProgressEvent = {
  [K in CliNdjsonProgressEvent]: {
    readonly event: K;
    readonly payload: CliNdjsonProgressEventPayloads[K];
  };
}[CliNdjsonProgressEvent];

export type CliNdjsonProgressRecordWriter = (record: CliNdjsonRecord) => void;

/** The run-fact vocabulary this projection's subscription filter admits. */
type CliRunFactEvent = Extract<
  AgentEvent,
  { type: (typeof RUN_FACT_EVENT_TYPES)[number] }
>;

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
    case 'status':
      return {
        event: 'updateStreamStatus',
        payload: {
          streamId: fact.streamId,
          status: fact.phase,
          cause: fact.cause,
          ...(fact.previousPhase ? { previousStatus: fact.previousPhase } : {}),
          ...(fact.substate ? { substate: fact.substate } : {}),
        },
      };
    case 'setParentStream':
      return { event: 'setParentStream', payload: fact.payload };
    case 'removeStream':
      return { event: 'removeStream', payload: fact.payload };
  }
  assertNever(fact, 'Unhandled CLI NDJSON session fact');
}

/**
 * Project run facts onto the frozen NDJSON progress-event vocabulary.
 * `run.start` is intentionally unprojected: the public wire shape carries no
 * run-start record.
 */
function projectCliRunFact(
  streamId: StreamTabId,
  event: CliRunFactEvent,
): CliProjectedNdjsonProgressEvent | undefined {
  switch (event.type) {
    case 'run.start':
      return undefined;
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
          filesByRound: event.filesByRound,
        },
      };
    case 'updateMissingOutputs':
      return {
        event: 'updateMissingOutputs',
        payload: {
          streamId: event.streamId,
          filesByRound: event.filesByRound,
        },
      };
    case 'updateCompileFailures':
      return {
        event: 'updateCompileFailures',
        payload: {
          streamId: event.streamId,
          filesByRound: event.filesByRound,
        },
      };
    case 'goalPaused':
      return { event: 'goalPaused', payload: { streamId: event.streamId } };
    case 'stage.start': {
      // The frozen public wire carries round progress only; phase progress
      // stays internal.
      const roundStage = roundStageFromStageStart(event);
      if (!roundStage) return undefined;
      return { event: 'updateRoundStage', payload: { streamId, roundStage } };
    }
    case 'child.activity':
      return {
        event: 'updateActiveSubagents',
        payload: {
          parentStreamId: event.parentStreamId,
          children: event.items.map(projectCliActiveChildRow),
        },
      };
  }
  assertNever(event, 'Unhandled CLI NDJSON run fact');
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

  const detachSessionFacts = events.subscribeSessionFacts((fact) => {
    const projected = projectCliSessionFact(fact);
    if (projected) emitProjected(projected);
  });
  const detachRunFacts = events.subscribeRunFacts(
    (runFact) => {
      const projected = projectCliRunFact(runFact.streamId, runFact.event);
      if (projected) emitProjected(projected);
    },
    { types: RUN_FACT_EVENT_TYPES },
  );

  return () => {
    detachRunFacts();
    detachSessionFacts();
  };
}
