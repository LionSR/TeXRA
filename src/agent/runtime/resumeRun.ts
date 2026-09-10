import { Effect, Result } from 'effect';

/**
 * The one resume entry point. Every host continues a persisted run through
 * it: the extension toolbar, the desktop bridge, the CLI `/resume` command and
 * `texra resume`, and the implicit follow-up wake. It resolves persisted
 * state, claims the stream's follow-up recovery lease, and launches the run
 * as a generation on its execution lane (`resumeToolUseFromResumeData` for
 * tool-use, the host's workflow launcher for workflows). The native child
 * loop keeps the unlaned `resumeToolUseTurn`: it already holds the lane.
 */
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type {
  FollowUpQueueBatchItem,
  FollowUpQueueInput,
} from '@agent/followUp/FollowUpQueue';
import {
  lookupRunId,
  recordRunRefusal,
  type FollowUpFailureReason,
} from '@agent/followUp/ToolUseFollowUp';
import type { FollowUpRecoveryLease } from '@agent/followUp/ToolUseFollowUpQueueManager';
import {
  RunLeaseActiveError,
  inspectRunLease,
} from '@agent/storage/executionLease';
import { getRunRecords } from '@agent/storage/ExecutionKVStore';
import { checkpointExists } from '@agent/storage/resumability';
import { PersistedFlowStateError } from '@agent/node/persistedFlow';
import { createLog } from '@logger/logUtils';
import type { RecoveryContinuation } from '@platform/interfaces';
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type RunId,
  type StreamTabId,
} from '@shared/schemas';
import { streamHeldMessage } from '@shared/streams/streamStatusDisplay';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import {
  isWaitingFlowResult,
  type AgentRuntimeFlowResult,
} from './AgentFlowResult';
import {
  ResumeSessionUnavailableError,
  resumeToolUseFromResumeData,
  type SubagentRunOptions,
} from './executeAgent';
import { classifyRun } from './runClassification';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from './SessionResumeRetrieval';
import { defaultSession, type SessionHandle } from './SessionHandle';
import type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';

/**
 * `started` once the resumed generation has settled (a tool-use turn parked
 * at WAITING or finished; a workflow run returned). `delivered` is false when
 * that generation returned but its drained follow-up batch was replayed onto
 * the stream queue instead of being consumed: the input still awaits
 * delivery, so a follow-up wake reports it as queued while an explicit resume
 * settles the turn it just ran. `outcome` carries the resumed tool-use run's
 * raw result (terminal or WAITING), absent on the workflow path and when the
 * run never returned one. A refusal carries the reason a host words with
 * `describeFollowUpFailure`. Unexpected failures (storage errors, the run
 * itself throwing) reject.
 */
export type ResumeRunResult =
  | {
      readonly started: true;
      readonly delivered: boolean;
      readonly outcome?: AgentRuntimeFlowResult['outcome'];
    }
  | { readonly failed: FollowUpFailureReason };

export interface ResumeRunOptions extends Pick<
  SubagentRunOptions,
  | 'session'
  | 'approvalPromptsUnavailable'
  | 'onApprovalPolicyDenial'
  | 'runtimeUnavailableTools'
> {
  /** Recovery ownership synchronously claimed by the submission boundary. */
  readonly recovery?: RecoveryContinuation;
  /** Monotone per-attempt cancellation signal: once true it stays true. */
  readonly isCancellationRequested?: () => boolean;
  /**
   * Follow-ups to replay ahead of any items already queued for the stream
   * (e.g. an explicit follow-up typed alongside a manual resume). Seeded
   * before the drain so the failure path re-enqueues them even if the drain
   * throws before the full list is assigned.
   *
   * The batch stays the caller's until {@link onFollowUpQueueReady} fires:
   * every refusal before that point returns it unqueued, and the caller must
   * put it back where it came from or the user's input is lost. Once the
   * queue owns it, a replay lands on the stream queue (`delivered: false`)
   * rather than back with the caller.
   */
  readonly extraFollowUps?: readonly FollowUpQueueInput[];
  /**
   * Fires after the shared stream queue is acquired and marked RESUMING, but
   * before its queued items are drained into the rebuilt session. This is the
   * one signal that the queue has taken ownership of `extraFollowUps`.
   */
  readonly onFollowUpQueueReady?: (recovery: FollowUpRecoveryLease) => void;
  /**
   * Fires once this run's persisted state has been retrieved and its launch
   * is the next step. It is the last point at which a refusal costs the
   * caller nothing, so a host that must rearrange itself onto the resumed run
   * (clearing a transcript, switching the focused stream) does it here rather
   * than reading the same checkpoint first to decide whether it may: a
   * history listing advertises a row from its checkpoint file alone (one
   * `stat`, never a parse) and inspects no lease per row, so both an unusable
   * checkpoint and a run another TeXRA process holds refuse above this hook
   * with the user's window untouched. A rejection propagates to the caller; a
   * stop requested while it runs is honored, because
   * {@link isCancellationRequested} is re-read once it returns.
   */
  readonly onResumeResolved?: () => Promise<void> | void;

  /**
   * Workflow launch owns stream acquisition and status transitions through
   * `runAgent`; each host supplies its own launcher.
   */
  readonly executeWorkflow: (
    config: AgentConfig,
    executionId: RunId,
    modelHandlerCompatibilityKey:
      ModelHandlerCompatibilityKey | null | undefined,
  ) => Promise<void>;
}

/**
 * Resume a stream through the single host entry path. Recovery is claimed
 * when the program starts, before the stream-to-execution index performs I/O.
 */
export const resumeStream = Effect.fn('resumeStream')(function* (
  streamId: StreamTabId,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeRunResult, Error> {
  const session = options.session ?? defaultSession();
  if (
    options.isCancellationRequested?.() === true ||
    session.executions.isActiveOrResuming(streamId)
  )
    return REFUSED;
  const recovery = options.recovery
    ? session.followUps.useRecovery(options.recovery)
    : session.followUps.claimRecovery(streamId, true);
  if (!recovery || recovery.streamId !== streamId) {
    if (recovery) session.followUps.release(recovery, 'recoverable');
    return REFUSED;
  }
  const executionId = yield* lookupRunId(streamId, session).pipe(
    Effect.onError(() =>
      Effect.sync(() =>
        releaseUnstartedRecovery(session, recovery, options.recovery == null),
      ),
    ),
  );
  if (!executionId) {
    releaseUnstartedRecovery(session, recovery, options.recovery == null);
    return REFUSED;
  }
  return yield* resumeRunWithRecoveryProvenance(
    executionId,
    { ...options, session, recovery },
    options.recovery == null,
  );
}, Effect.uninterruptible);

const log = createLog('ResumeRun');

const REFUSED: ResumeRunResult = { failed: 'not_resumable' };
/** A workflow run carries no follow-up batch, so nothing awaits delivery. */
const WORKFLOW_STARTED: ResumeRunResult = { started: true, delivered: true };

/**
 * Positive evidence that the checkpoint itself is what failed, walking the
 * cause chain the retrieval boundary wraps its failures in. `persistedFlow`
 * throws this for a record that cannot be resumed (malformed, spent, an
 * unsupported format); its `read-failed` reason is a transient storage
 * failure, which is not evidence about the record. Every other failure on the
 * resume path — a rejected snapshot preload, a KV or metadata read, a lease
 * read — stays the operational error the host words with its cause.
 */
function namesUnusableCheckpoint(error: unknown): boolean {
  for (let current = error, depth = 0; depth < 8; depth++) {
    if (current instanceof PersistedFlowStateError) {
      return current.reason !== 'read-failed';
    }
    if (!(current instanceof Error) || current.cause === undefined)
      return false;
    current = current.cause;
  }
  return false;
}

// The existing host cancellation predicate controls the Promise-based launch.
// Keep its queue owner until that launch and its cleanup have settled.
export const resumeRun = Effect.fn('resumeRun')(function* (
  executionId: RunId,
  options: ResumeRunOptions,
) {
  return yield* resumeRunWithRecoveryProvenance(executionId, options, false);
}, Effect.uninterruptible);

/** Resume preparation is one ordered program; checkpoint interpretation is unchanged. */
const resumeRunWithRecoveryProvenance = Effect.fn(
  'resumeRunWithRecoveryProvenance',
)(function* (
  executionId: RunId,
  options: ResumeRunOptions,
  recoveryIsProvisional: boolean,
): Effect.fn.Return<ResumeRunResult, Error> {
  const session = options.session ?? defaultSession();
  const cancelled = () => options.isCancellationRequested?.() === true;
  const suppliedRecovery = options.recovery
    ? session.followUps.useRecovery(options.recovery)
    : undefined;
  const abandonSupplied = (provisional = recoveryIsProvisional): void => {
    if (suppliedRecovery)
      releaseUnstartedRecovery(session, suppliedRecovery, provisional);
  };
  const store = getRunRecords(session, executionId);
  const [config, meta] = yield* Effect.all([
    store.readConfig(),
    store.readMeta(),
  ]).pipe(Effect.onError(() => Effect.sync(() => abandonSupplied())));
  const streamId = meta?.streamId;
  if (!config || !streamId) {
    abandonSupplied();
    return REFUSED;
  }
  if (suppliedRecovery && suppliedRecovery.streamId !== streamId) {
    abandonSupplied(false);
    return REFUSED;
  }
  if (cancelled() || session.executions.isActiveOrResuming(streamId)) {
    abandonSupplied();
    return REFUSED;
  }
  // Claim before retrieval so concurrent follow-ups join this attempt's queue.
  let queueLease: FollowUpRecoveryLease | undefined;
  if (config.agentCategory === AgentCategory.ToolUse) {
    queueLease = options.recovery
      ? session.followUps.useRecovery(options.recovery)
      : session.followUps.claimRecovery(streamId, true);
  }
  if (config.agentCategory === AgentCategory.ToolUse && !queueLease)
    return REFUSED;
  if (config.agentCategory !== AgentCategory.ToolUse) abandonSupplied();
  const releaseQueue = (): void => {
    if (queueLease) session.followUps.release(queueLease, 'recoverable');
  };
  const retrieved = yield* Effect.result(
    Effect.gen(function* () {
      const snapshots = session.snapshots;
      if (snapshots.getRunMetadata(streamId).executionId === undefined)
        yield* snapshots.preload([streamId]);
      return yield* retrieveSessionResumeData(
        streamId,
        executionId,
        config,
        session,
        {
          parentStreamId: snapshots.getParentStreamId(streamId),
        },
      );
    }),
  );
  if (Result.isFailure(retrieved)) {
    releaseQueue();
    if (!namesUnusableCheckpoint(retrieved.failure))
      return yield* Effect.fail(retrieved.failure);
    log.warn(
      `Refusing to resume ${executionId}: its checkpoint holds no resumable state: ${toErrorMessage(retrieved.failure)}`,
      { data: retrieved.failure },
    );
    return { failed: 'unusable_checkpoint' };
  }
  const resume = retrieved.success;
  if (cancelled() || session.executions.isActiveOrResuming(streamId)) {
    releaseQueue();
    return REFUSED;
  }
  if (!resume) {
    releaseQueue();
    const classification = yield* classifyRun(executionId, session);
    const failed = recordRunRefusal(streamId, session, classification);
    if (
      classification.kind === 'held_elsewhere' ||
      classification.kind === 'owned_here'
    )
      return { failed };
    const unusable =
      classification.kind === 'unclassified'
        ? classification.fault === 'checkpoint-malformed'
        : yield* checkpointExists(executionId, session);
    if (!unusable) return { failed };
    log.warn(
      `Refusing to resume ${executionId}: its checkpoint holds no resumable state.`,
    );
    return { failed: 'unusable_checkpoint' };
  }
  const willLaunch = (resume.type === 'toolUse') === (queueLease !== undefined);
  const lease =
    willLaunch && options.onResumeResolved
      ? yield* Effect.tryPromise({
          try: () => inspectRunLease(executionId),
          catch: ensureError,
        }).pipe(Effect.onError(() => Effect.sync(releaseQueue)))
      : undefined;
  session.status.clearHold(streamId, { discardRetainedPhase: true });
  if (lease?.status === 'held') {
    releaseQueue();
    session.status.markUnavailable(
      streamId,
      streamHeldMessage(lease.owner.pid),
    );
    return { failed: 'owned_elsewhere' };
  }
  if (willLaunch && options.onResumeResolved) {
    const onResumeResolved = options.onResumeResolved;
    yield* Effect.tryPromise({
      try: async () => onResumeResolved(),
      catch: ensureError,
    }).pipe(Effect.onError(() => Effect.sync(releaseQueue)));
    if (cancelled() || session.executions.isActiveOrResuming(streamId)) {
      releaseQueue();
      return REFUSED;
    }
  }
  if (resume.type === 'toolUse' && queueLease) {
    return yield* resumeQueuedToolUse(session, resume, queueLease, options);
  }
  if (resume.type === 'workflow' && !queueLease) {
    const launched = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          options.executeWorkflow(
            resume.agentConfig,
            resume.executionId,
            resume.modelHandlerCompatibilityKey,
          ),
        catch: ensureError,
      }),
    );
    if (Result.isFailure(launched)) {
      const refused = refusalFor(launched.failure, session, streamId);
      if (refused) return refused;
      return yield* Effect.fail(launched.failure);
    }
    return WORKFLOW_STARTED;
  }
  releaseQueue();
  return REFUSED;
});

function releaseUnstartedRecovery(
  session: SessionHandle,
  recovery: FollowUpRecoveryLease,
  provisional: boolean,
): void {
  const current = session.followUps.useRecovery(recovery);
  if (!current) return;
  if (provisional && session.followUps.queue(current).isEmpty()) {
    session.followUps.terminalize(current.streamId);
    return;
  }
  session.followUps.release(current, 'recoverable');
}

/**
 * The two expected launch failures a host words; anything else rejects.
 *
 * A refusal is also the one moment this process learns, for the run the user
 * just asked to open, that another live TeXRA process holds it. That fact is
 * recorded on the stream so every surface renders it read-only with the same
 * copy until this stream is opened successfully — after the boot-time repair
 * pass is gone, an open-for-write and a sidecar hydration are the only two
 * producers of it.
 */
function refusalFor(
  error: unknown,
  session: SessionHandle,
  streamId: StreamTabId,
): ResumeRunResult | undefined {
  if (error instanceof RunLeaseActiveError) {
    session.status.markUnavailable(
      streamId,
      streamHeldMessage(error.owner.pid),
    );
    return { failed: 'owned_elsewhere' };
  }
  if (error instanceof ResumeSessionUnavailableError) {
    return { failed: 'finished' };
  }
  return undefined;
}

/**
 * The tool-use resume "queue dance": flip the stream to RESUMING, drain the
 * queued follow-ups and notify the UI, resume while handing the drained batch
 * to the flow's WAITING cursor via `drainedFollowUps`, on failure re-enqueue
 * the follow-ups and re-notify, and always return the stream to WAITING if
 * the resume never reached the run lifecycle.
 */
const resumeQueuedToolUse = Effect.fn('resumeQueuedToolUse')(function* (
  session: SessionHandle,
  resume: ToolUseResumeData,
  queueLease: FollowUpRecoveryLease,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeRunResult, Error> {
  const { streamId } = resume;
  const streamStatus = session.status;
  const followUpsQueue = session.followUps;

  if (
    session.executions.getHandle(resume.executionId)
      ?.suspendedTerminationStarted
  ) {
    followUpsQueue.release(queueLease, 'recoverable');
    return REFUSED;
  }
  streamStatus.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
    substate: STREAM_SUBSTATE.RESUMING,
  });

  const seed = options.extraFollowUps ?? [];
  let followUps: readonly FollowUpQueueInput[] = seed;
  let cancelledAtFlowAttachment = false;
  let followUpsRestored = false;
  let runResult: AgentRuntimeFlowResult | undefined;
  const notifyQueued = (): void => {
    session.publish([
      {
        type: 'updateQueuedFollowUps',
        aggregateId: qualifyAggregateId('stream', streamId),
        messages: session.followUps.getAll(streamId),
      },
    ]);
  };
  const restoreFollowUps = (): void => {
    if (followUpsRestored) return;
    followUpsRestored = true;
    followUpsQueue.queue(queueLease).restore(followUps);
    if (followUps.length > 0) notifyQueued();
  };
  const resumed = yield* Effect.result(
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => {
          options.onFollowUpQueueReady?.(queueLease);
          followUps = [
            ...seed,
            ...followUpsQueue.queue(queueLease).drainItems(),
          ];
          notifyQueued();
        },
        catch: ensureError,
      });

      // The drained batch must reach the resumed flow through the direct
      // `drainedFollowUps` handoff, not by re-queuing: a subagent's WAITING
      // cursor suspends again before ever reading the stream queue (see
      // `ToolUseWaitNode`; only its child-run loop's queue wait consumes it),
      // so re-queued items would sit unconsumed until the next wake. A root
      // cursor accepts either route; the handoff works for both.
      return yield* resumeToolUseFromResumeData(resume, {
        session,
        approvalPromptsUnavailable: options.approvalPromptsUnavailable,
        onApprovalPolicyDenial: options.onApprovalPolicyDenial,
        runtimeUnavailableTools: options.runtimeUnavailableTools,
        parentStreamId: resume.parentStreamId,
        onFollowUpConsumed: () => {
          followUps = [];
        },
        isCancellationRequested: options.isCancellationRequested,
        onCancellationAtFlowAttachment: () => {
          cancelledAtFlowAttachment = true;
        },
        drainedFollowUps: followUps.map(toFollowUpBatchItem),
        // The first call closes the gap between the initial drain and live-flow
        // attachment. Later calls occur after a subagent parks at WAITING. A
        // native child loop owns that queue boundary when registered; otherwise
        // this host resume must claim the late batch so input accepted by the
        // live context cannot remain dormant.
        takePendingFollowUps: () => {
          const raced = followUpsQueue.queue(queueLease).drainItems();
          followUps = [...followUps, ...raced];
          return raced.map(toFollowUpBatchItem);
        },
      });
    }),
  ).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (Result.isSuccess(result)) runResult = result.success;
        // Replay only input the resumed flow has not acknowledged.
        if (followUps.length > 0) restoreFollowUps();
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        // Early failures leave the stream RESUMING. Startup cancellation can
        // instead reach lifecycle terminalization before the queue owner regains
        // control. In both cases, restored input makes WAITING the durable state.
        if (
          cancelledAtFlowAttachment ||
          followUpsRestored ||
          streamStatus.getSubstate(streamId) === STREAM_SUBSTATE.RESUMING
        ) {
          streamStatus.transitionToWaiting(streamId, 'wait');
        }
        followUpsQueue.release(
          queueLease,
          !runResult || isWaitingFlowResult(runResult) || followUpsRestored
            ? 'recoverable'
            : 'terminal',
        );
      }),
    ),
  );
  if (Result.isFailure(resumed)) {
    const refusal = refusalFor(resumed.failure, session, streamId);
    if (refusal) return refusal;
    return yield* Effect.fail(resumed.failure);
  }
  // Cancellation at flow attachment means the run was never reached; a replay
  // means it ran and returned with the batch back on the stream queue.
  if (cancelledAtFlowAttachment) return REFUSED;
  return {
    started: true,
    delivered: !followUpsRestored,
    outcome: runResult?.outcome,
  };
});

function toFollowUpBatchItem(item: FollowUpQueueInput): FollowUpQueueBatchItem {
  return {
    text: item.text,
    displayText: item.displayText,
    mediaFiles: item.mediaFiles,
    origin: item.origin ?? 'user',
  };
}
