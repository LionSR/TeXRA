import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';

import { agentConfigToTaskState, type SessionHandle } from '@agent/runtime';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import { effectRuntime } from '@platform/processRuntime';
import {
  aggregateTarget,
  type ActiveChildInfo,
  type DisplaySessionEvent,
  type RunId,
  type RunPhase,
} from '@shared/schemas';
import { roundStageFromStageStart } from '@shared/runs/stage';
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
  const { identity, childRunId, ...rest } = item;
  const toolName =
    identity.kind === 'multiAgentWorkflow'
      ? 'delegate_multi_agents'
      : identity.tool;
  return {
    kind: identity.kind === 'process' ? 'process' : 'subagent',
    executionId: childRunId,
    ...rest,
    ...(toolName !== undefined ? { toolName } : {}),
    ...(identity.kind === 'process' ? {} : { childStreamId: childRunId }),
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
 * vocabulary: one event to zero or one line, over two bits of tail-local
 * state per run: the parent edge its `run.start` carried (PRD 10.3) and the
 * phase it was last projected in, which the terminal line reports as the
 * 0.40 `previousStatus`.
 *
 * `run.activate` projects to the public `setActiveStream` record, one to one
 * and byte for byte: every activation (a launch, a resume) emits one line, a
 * delegated child's activation carries the record's `suppressViewSwitch:
 * true` (the 0.40 spelling of the parent edge), and `isRemote` appears only
 * where the fact carries one (agent launches; a child never did). `run.start`
 * is the existence fact: a child's projects the frozen `setParentStream`
 * line its parent edge used to be published as, a root's projects nothing.
 * `context.state`, the approval facts, the terminal result, and transcript
 * rows are intentionally unprojected (the result has its own NDJSON record,
 * and the public wire carries neither a context-occupancy, an approval, nor a
 * transcript record). The goal and queued-follow-up records carry only the
 * run they name, as the public wire always did.
 */
function projectCliSessionEvent(
  event: DisplaySessionEvent,
  isChild: (runId: RunId) => boolean,
  previousPhaseOf: (runId: RunId) => RunPhase | undefined,
): CliProjectedNdjsonProgressEvent | undefined {
  const target = aggregateTarget(event.aggregateId);
  if (target.kind !== 'run') {
    if (event.type !== 'inquiryThreadUpdated') return undefined;
    const {
      aggregateId: _aggregateId,
      seq: _seq,
      commit: _commit,
      ownerId: _ownerId,
      at: _at,
      type: _type,
      parentRunId,
      ...thread
    } = event;
    return {
      event: 'inquiryThreadUpdated',
      payload: { ...thread, parentStreamId: parentRunId },
    };
  }
  const runId = target.id;
  switch (event.type) {
    case 'run.activate':
      return {
        event: 'setActiveStream',
        payload: {
          streamId: runId,
          agentCategory: event.category,
          ...(event.isRemote != null ? { isRemote: event.isRemote } : {}),
          ...(isChild(runId) ? { suppressViewSwitch: true } : {}),
        },
      };
    case 'run.start':
      return event.parent === null
        ? undefined
        : {
            event: 'setParentStream',
            payload: {
              childStreamId: runId,
              parentStreamId: event.parent.id,
            },
          };
    case 'run.detach':
      return {
        event: 'setParentStream',
        payload: { childStreamId: runId, parentStreamId: null },
      };
    case 'approval.requested':
    case 'approval.resolved':
    case 'approval.policy':
    case 'context.state':
    case 'log':
    case 'stage.end':
    case 'tool.start':
    case 'tool.end':
    case 'workflow.plan':
    case 'workflow.call':
    case 'skills.snapshot':
    case 'stream.start':
    case 'stream.end':
    case 'response.finalized':
    case 'domain':
    case 'transcript.entry':
      return undefined;
    case 'run.end': {
      // The 0.40 wire's terminal status line, from the one terminal row. The
      // phase the run left is the one this tail last projected, so a consumer
      // keying on `previousStatus` still reads the machine's `from`. The
      // transition cause is the one thing the terminal row cannot supply:
      // `run.end` carries an outcome, not a cause, so the line says
      // `lifecycle` where the retired terminal `status` row said `user-stop`.
      // That loss is part of S5's version-2 envelope, not a gap to fill here.
      const previousStatus = previousPhaseOf(runId);
      return {
        event: 'updateStreamStatus',
        payload: {
          streamId: runId,
          status: event.outcome,
          cause: 'lifecycle',
          ...(previousStatus ? { previousStatus } : {}),
        },
      };
    }
    case 'status':
      return {
        event: 'updateStreamStatus',
        payload: {
          streamId: runId,
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
          streamId: runId,
          storageKey: event.runId,
          usage: event.usage,
        },
      };
    case 'run.config':
      // Publication validates the canonical AgentConfig before this frozen
      // task-state projection reads its fields.
      return {
        event: 'setTaskState',
        payload: {
          streamId: runId,
          executionId: runId,
          taskState: agentConfigToTaskState(event.config),
        },
      };
    case 'conversation.progress':
      return {
        event: 'updateConversationProgress',
        payload: { streamId: runId, progress: event.progress },
      };
    case 'updateTodos':
      return {
        event: 'updateTodos',
        payload: { streamId: runId, todos: event.todos },
      };
    case 'updatePlan':
      return {
        event: 'updatePlan',
        payload: { streamId: runId, plan: event.plan },
      };
    case 'addOutputFiles':
      return {
        event: 'addOutputFiles',
        payload: { streamId: runId, filesByRound: event.filesByRound },
      };
    case 'updateMissingOutputs':
      return {
        event: 'updateMissingOutputs',
        payload: { streamId: runId, filesByRound: event.filesByRound },
      };
    case 'updateCompileFailures':
      return {
        event: 'updateCompileFailures',
        payload: { streamId: runId, filesByRound: event.filesByRound },
      };
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
      return {
        event: 'updateRoundStage',
        payload: { streamId: runId, roundStage },
      };
    }
    case 'goalStateChanged':
      return { event: 'goalStateChanged', payload: { streamId: runId } };
    case 'inquiryThreadUpdated':
      // The thread aggregate is not a run; handled above.
      return undefined;
    case 'updateQueuedFollowUps':
      return { event: 'updateQueuedFollowUps', payload: { streamId: runId } };
    case 'run.description':
      return {
        event: 'updateStreamDescription',
        payload: { streamId: runId, description: event.description },
      };
    case 'run.removed':
      return { event: 'removeStream', payload: { streamId: runId } };
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
 * durable event behind it: the roster is process-local registry state
 * (contract C3) and reaches this projection through the registry's
 * `onChildActivity` listener. It is written in publish order all the same: a
 * roster observed at ordinal N follows every event committed at or below N, so
 * it waits for the tail to deliver N and goes out before anything committed
 * after it.
 *
 * Detaching drains: the tail runs to the ordinal captured at detach, so the
 * last line published before the run settled is on the wire before the
 * caller writes its result record. The drain waits on the tail's own
 * coordinate (`SessionEvents.all`'s `drained`), not on the events: a
 * transcript row the store no longer holds emits nothing, and the ordinal
 * captured at detach may be exactly that row's.
 */
export function attachCliSessionProgressProjection(
  session: Pick<SessionHandle, 'events' | 'now' | 'view'> & {
    readonly runs: Pick<SessionHandle['runs'], 'onChildActivity'>;
  },
  writeRecord: CliNdjsonProgressRecordWriter = writeNdjsonStdout,
): () => Promise<void> {
  // The parent edge as this tail has seen it: a `run.start` with a parent
  // adds, a `run.detach` removes. A run whose creation predates the tail (a
  // resume of an earlier run) is asked of the folded view, which holds its
  // `run.start` by then.
  const children = new Set<RunId>();
  const isChild = (runId: RunId): boolean =>
    children.has(runId) ||
    (SubscriptionRef.getUnsafe(session.view).runs.get(runId)?.parentId ??
      null) !== null;
  // The phase each run was last projected in. The terminal `run.end` line
  // carries it as the 0.40 `previousStatus` the retired terminal `status`
  // row used to supply; the fold is not read for it, because this tail and
  // the fold advance independently and the fold may already hold the outcome.
  const phases = new Map<RunId, RunPhase>();
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
        const target = aggregateTarget(event.aggregateId);
        if (
          target.kind === 'run' &&
          (event.type === 'run.start' || event.type === 'run.detach')
        ) {
          // The edge as this tail last saw it: `run.start` with a parent
          // opens it, `run.detach` closes it. Without the removal a
          // detached run that activates again would still be projected as
          // a child.
          if (event.type === 'run.start' && event.parent !== null) {
            children.add(target.id);
          } else {
            children.delete(target.id);
          }
        }
        const projected = projectCliSessionEvent(event, isChild, (id) =>
          phases.get(id),
        );
        if (projected) emitProjected(projected);
        // After projecting, so the terminal line reads the phase the run left.
        if (target.kind === 'run') {
          if (event.type === 'status') phases.set(target.id, event.phase);
          else if (event.type === 'run.end' || event.type === 'run.removed') {
            phases.delete(target.id);
          }
        }
        passed(event.commit);
      }),
    ),
  );
  const coordinateFiber = effectRuntime().runFork(
    Stream.runForEach(SubscriptionRef.changes(drainedTo), (commit) =>
      Effect.sync(() => passed(commit)),
    ),
  );
  const detachRosters = session.runs.onChildActivity((parentRunId, items) => {
    const projected: CliProjectedNdjsonProgressEvent = {
      event: 'updateActiveSubagents',
      payload: {
        parentStreamId: parentRunId,
        children: items.map(projectCliActiveChildRow),
      },
    };
    const at = session.now();
    if (at <= delivered) emitProjected(projected);
    else heldRosters.push({ at, projected });
  });

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
