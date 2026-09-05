import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';

import { agentConfigToTaskState, type SessionHandle } from '@agent/runtime';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import { effectRuntime } from '@platform/processRuntime';
import type {
  ActiveChildInfo,
  SessionEvent,
  StreamTabId,
} from '@shared/schemas';
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
  const { identity, childStreamId, ...rest } = item;
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

/**
 * Project one session event onto the frozen NDJSON progress-event
 * vocabulary: one event to zero or one line, no cumulative state (PRD 10.3).
 *
 * `run.activate` projects to the public `setActiveStream` record, one to one
 * and byte for byte: every activation (a launch, a resume) emits one line,
 * `background` (a delegated child) is the record's `suppressViewSwitch:
 * true`, and `isRemote` appears only where the fact carries one (agent
 * launches; a child stream never did). `run.start` is the existence fact and
 * projects nothing: a resume mints none, and a launch emits both.
 * `context.state`, the approval facts, the terminal result, and transcript
 * rows are intentionally unprojected (the result has its own NDJSON record,
 * and the public wire carries neither a context-occupancy, an approval, nor a
 * transcript record). The goal and queued-follow-up records carry only the
 * stream they name, as the public wire always did.
 */
function projectCliSessionEvent(
  event: SessionEvent,
): CliProjectedNdjsonProgressEvent | undefined {
  const streamId = event.aggregateId as StreamTabId;
  switch (event.type) {
    case 'run.activate':
      return {
        event: 'setActiveStream',
        payload: {
          streamId,
          agentCategory: event.category,
          ...(event.isRemote != null ? { isRemote: event.isRemote } : {}),
          ...(event.background ? { suppressViewSwitch: true } : {}),
        },
      };
    case 'run.start':
    case 'approval.requested':
    case 'approval.resolved':
    case 'approval.policy':
    case 'result':
    case 'context.state':
    case 'transcript.entry':
      return undefined;
    case 'status':
      return {
        event: 'updateStreamStatus',
        payload: {
          streamId,
          status: event.phase,
          cause: event.cause,
          ...(event.previousPhase
            ? { previousStatus: event.previousPhase }
            : {}),
          ...(event.substate ? { substate: event.substate } : {}),
        },
      };
    case 'usage':
      return {
        event: 'updateStreamUsage',
        payload: {
          streamId,
          storageKey: event.storageKey,
          usage: event.usage,
        },
      };
    case 'run.config':
      // The producers publish the run's whole `AgentConfig`; the durable
      // schema is a loose object that keeps every key, so the frozen
      // `taskState` line carries the same bytes it always did.
      return {
        event: 'setTaskState',
        payload: {
          streamId,
          executionId: event.executionId,
          taskState: agentConfigToTaskState(
            event.config as Parameters<typeof agentConfigToTaskState>[0],
          ),
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
        payload: { streamId, todos: event.todos },
      };
    case 'updatePlan':
      return {
        event: 'updatePlan',
        payload: { streamId, plan: event.plan },
      };
    case 'addOutputFiles':
      return {
        event: 'addOutputFiles',
        payload: { streamId, filesByRound: event.filesByRound },
      };
    case 'updateMissingOutputs':
      return {
        event: 'updateMissingOutputs',
        payload: { streamId, filesByRound: event.filesByRound },
      };
    case 'updateCompileFailures':
      return {
        event: 'updateCompileFailures',
        payload: { streamId, filesByRound: event.filesByRound },
      };
    case 'goalPaused':
      return { event: 'goalPaused', payload: { streamId } };
    case 'stage.start': {
      // The frozen public wire carries round progress only; phase progress
      // stays internal.
      const roundStage = roundStageFromStageStart({
        label: event.label,
        kind: event.kind ?? undefined,
        index: event.index ?? undefined,
        total: event.total ?? undefined,
      });
      if (!roundStage) return undefined;
      return { event: 'updateRoundStage', payload: { streamId, roundStage } };
    }
    case 'goalStateChanged':
      return { event: 'goalStateChanged', payload: { streamId } };
    case 'inquiryThreadUpdated': {
      const {
        aggregateId: _aggregateId,
        seq: _seq,
        commit: _commit,
        ownerId: _ownerId,
        at: _at,
        type: _type,
        ...thread
      } = event;
      return { event: 'inquiryThreadUpdated', payload: thread };
    }
    case 'updateQueuedFollowUps':
      return { event: 'updateQueuedFollowUps', payload: { streamId } };
    case 'updateStreamDescription':
      return {
        event: 'updateStreamDescription',
        payload: { streamId, description: event.description },
      };
    case 'setParentStream':
      return {
        event: 'setParentStream',
        payload: {
          childStreamId: streamId,
          parentStreamId: event.parentStreamId,
        },
      };
    case 'stream.removed':
      return { event: 'removeStream', payload: { streamId } };
  }
  assertNever(event, 'Unhandled CLI NDJSON session event');
}

/**
 * Headless CLI compatibility adapter. Public NDJSON output still speaks the
 * frozen progress-event vocabulary inside `kind: "progress"` records, so this
 * boundary alone translates the session's events into that public wire.
 *
 * It reads `events.all(session.now())` directly (PRD 10.3): every event
 * above the current ordinal in commit order, never the view, so a
 * `stage.start` no surface subscribed to still becomes its line and two
 * same-type updates never collapse. The child roster is the one line with no
 * durable event behind it: `child.activity` is process-local registry state
 * (contract C3) and reaches this projection through the registry's
 * listener. It is written in publish order all the same: a roster observed
 * at ordinal N follows every event committed at or below N, so it waits for
 * the tail to deliver N and goes out before anything committed after it.
 *
 * Detaching drains: the tail runs to the ordinal captured at detach, so the
 * last line published before the run settled is on the wire before the
 * caller writes its result record. The drain waits on the tail's own
 * coordinate (`SessionEvents.all`'s `drained`), not on the events: a
 * transcript row the store no longer holds emits nothing, and the ordinal
 * captured at detach may be exactly that row's.
 */
export function attachCliSessionProgressProjection(
  session: Pick<SessionHandle, 'events' | 'now'> & {
    readonly executions: Pick<SessionHandle['executions'], 'onChildActivity'>;
  },
  writeRecord: CliNdjsonProgressRecordWriter = writeNdjsonStdout,
): () => Promise<void> {
  function emitProjected(projected: CliProjectedNdjsonProgressEvent): void {
    writeRecord({
      kind: 'progress',
      event: projected.event,
      ts: new Date().toISOString(),
      payload: projected.payload,
    });
  }

  /** The last commit the tail passed; rosters observed above it wait. */
  let delivered = session.now();
  /** The ordinal detach cut at; nothing above it is written. */
  let stopAt: number | undefined;
  const heldRosters: Array<{
    readonly at: number;
    readonly projected: CliProjectedNdjsonProgressEvent;
  }> = [];
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  const flushRosters = (upTo: number): void => {
    while (heldRosters.length > 0 && heldRosters[0]!.at <= upTo) {
      emitProjected(heldRosters.shift()!.projected);
    }
  };
  const settleIfDrained = (): void => {
    if (stopAt === undefined || delivered < stopAt) return;
    flushRosters(stopAt);
    resolveDrained();
  };
  const passed = (commit: number): void => {
    delivered = Math.max(delivered, commit);
    flushRosters(delivered);
    settleIfDrained();
  };

  // The tail's coordinate: set to the commit each forward read covered once
  // that read's events have all been handled below, so a value here never
  // runs ahead of an event this fiber has yet to write.
  const drainedTo = effectRuntime().runSync(SubscriptionRef.make(delivered));
  const fiber = effectRuntime().runFork(
    Stream.runForEach(session.events.all(delivered, drainedTo), (event) =>
      Effect.sync(() => {
        if (stopAt !== undefined && event.commit > stopAt) return;
        const projected = projectCliSessionEvent(event);
        if (projected) emitProjected(projected);
        passed(event.commit);
      }),
    ),
  );
  const coordinateFiber = effectRuntime().runFork(
    Stream.runForEach(SubscriptionRef.changes(drainedTo), (commit) =>
      Effect.sync(() => passed(commit)),
    ),
  );
  const detachRosters = session.executions.onChildActivity(
    (parentStreamId, items) => {
      const projected: CliProjectedNdjsonProgressEvent = {
        event: 'updateActiveSubagents',
        payload: {
          parentStreamId,
          children: items.map(projectCliActiveChildRow),
        },
      };
      const at = session.now();
      if (at <= delivered) emitProjected(projected);
      else heldRosters.push({ at, projected });
    },
  );

  return async () => {
    if (stopAt !== undefined) return drained;
    detachRosters();
    stopAt = session.now();
    settleIfDrained();
    await drained;
    effectRuntime().runFork(Fiber.interrupt(fiber));
    effectRuntime().runFork(Fiber.interrupt(coordinateFiber));
  };
}
