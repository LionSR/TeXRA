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
  lookupStreamExecutionId,
  recordRunRefusal,
  type FollowUpFailureReason,
} from '@agent/followUp/ToolUseFollowUp';
import type { FollowUpRecoveryLease } from '@agent/followUp/ToolUseFollowUpQueueManager';
import {
  ExecutionLeaseActiveError,
  inspectExecutionLease,
} from '@agent/storage/executionLease';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { checkpointExists } from '@agent/storage/resumability';
import { PersistedFlowStateError } from '@agent/node/persistedFlow';
import { createLog } from '@logger/logUtils';
import type { RecoveryContinuation } from '@platform/interfaces';
import {
  AgentCategory,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { streamHeldMessage } from '@shared/streams/streamStatusDisplay';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
    executionId: ExecutionId,
    modelHandlerCompatibilityKey:
      ModelHandlerCompatibilityKey | null | undefined,
  ) => Promise<void>;
}

/**
 * Resume a stream through the single host entry path. Recovery is claimed
 * synchronously, before the stream-to-execution index can perform disk I/O.
 */
export async function resumeStream(
  streamId: StreamTabId,
  options: ResumeRunOptions,
): Promise<ResumeRunResult> {
  const session = options.session ?? defaultSession();
  if (
    options.isCancellationRequested?.() === true ||
    session.executions.isActiveOrResuming(streamId)
  ) {
    return REFUSED;
  }

  const recovery = options.recovery
    ? session.followUps.useRecovery(options.recovery)
    : session.followUps.claimRecovery(streamId, true);
  if (!recovery || recovery.streamId !== streamId) {
    if (recovery) session.followUps.release(recovery, 'recoverable');
    return REFUSED;
  }

  try {
    const executionId = await lookupStreamExecutionId(streamId, session);
    if (!executionId) {
      releaseUnstartedRecovery(session, recovery, options.recovery == null);
      return REFUSED;
    }
    return resumeRunWithRecoveryProvenance(
      executionId,
      { ...options, session, recovery },
      options.recovery == null,
    );
  } catch (error) {
    releaseUnstartedRecovery(session, recovery, options.recovery == null);
    throw error;
  }
}

export { lookupStreamExecutionId } from '@agent/followUp/ToolUseFollowUp';

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

export async function resumeRun(
  executionId: ExecutionId,
  options: ResumeRunOptions,
): Promise<ResumeRunResult> {
  return resumeRunWithRecoveryProvenance(executionId, options, false);
}

async function resumeRunWithRecoveryProvenance(
  executionId: ExecutionId,
  options: ResumeRunOptions,
  recoveryIsProvisional: boolean,
): Promise<ResumeRunResult> {
  const session = options.session ?? defaultSession();
  const isCancellationRequested = (): boolean =>
    options.isCancellationRequested?.() === true;

  const suppliedRecovery = options.recovery
    ? session.followUps.useRecovery(options.recovery)
    : undefined;
  /** Give the caller-supplied recovery back on every path that never starts. */
  const abandonSupplied = (provisional = recoveryIsProvisional): void => {
    if (suppliedRecovery) {
      releaseUnstartedRecovery(session, suppliedRecovery, provisional);
    }
  };

  const store = getExecutionStore(executionId);
  let config: Awaited<ReturnType<typeof store.readConfig>>;
  let meta: Awaited<ReturnType<typeof store.readMeta>>;
  try {
    [config, meta] = await Promise.all([store.readConfig(), store.readMeta()]);
  } catch (error) {
    abandonSupplied();
    throw error;
  }
  // FK-first: the stream id stamped at registration is the reproduction
  // contract. A row without one has no persisted stream to continue.
  const streamId = meta?.streamId;
  if (!config || !streamId) {
    abandonSupplied();
    return REFUSED;
  }
  if (suppliedRecovery && suppliedRecovery.streamId !== streamId) {
    // A stream mismatch is never provisional: the entry belongs to another
    // stream, so it stays recoverable there.
    abandonSupplied(false);
    return REFUSED;
  }
  // A stream that is already running or resuming in this process is refused,
  // not queued on the lane: a workflow run holds no follow-up queue consumer
  // and a queued resume would otherwise rerun it after it finishes.
  if (
    isCancellationRequested() ||
    session.executions.isActiveOrResuming(streamId)
  ) {
    abandonSupplied();
    return REFUSED;
  }

  // Claim recovery before the asynchronous retrieval: a follow-up submitted
  // meanwhile joins this resume's queue instead of starting a second one.
  let queueLease: FollowUpRecoveryLease | undefined;
  if (config.agentCategory === AgentCategory.ToolUse) {
    queueLease = options.recovery
      ? session.followUps.useRecovery(options.recovery)
      : session.followUps.claimRecovery(streamId, true);
    if (!queueLease) return REFUSED;
  } else {
    // Workflow runs have no follow-up consumer. An empty entry created only
    // for lookup can be terminalized; caller-supplied or raced input remains
    // recoverable so no user message or release observer is lost.
    abandonSupplied();
  }

  let resume: Awaited<ReturnType<typeof retrieveSessionResumeData>>;
  try {
    const snapshots = session.snapshots;
    if (
      snapshots.getRunMetadata(streamId, { quiet: true }).executionId ===
      undefined
    ) {
      await snapshots.preload([streamId]);
    }
    resume = await retrieveSessionResumeData(streamId, executionId, config, {
      parentStreamId: snapshots.getParentStreamId(streamId),
    });
  } catch (error) {
    if (queueLease) session.followUps.release(queueLease, 'recoverable');
    // A checkpoint that is on disk but cannot be turned into resume state (a
    // malformed envelope, an unsupported record) throws here. That is a
    // refusal to word for the row that advertised it; anything else that
    // failed on the way is the storage error it has always been.
    if (!namesUnusableCheckpoint(error)) throw error;
    log.warn(
      `Refusing to resume ${executionId}: its checkpoint holds no resumable state: ${toErrorMessage(error)}`,
      { data: error },
    );
    return { failed: 'unusable_checkpoint' };
  }
  if (
    isCancellationRequested() ||
    // Re-check after the retrieval await: a launch of this stream may have
    // been admitted meanwhile, and the lane would queue, not refuse, this one.
    session.executions.isActiveOrResuming(streamId)
  ) {
    if (queueLease) session.followUps.release(queueLease, 'recoverable');
    return REFUSED;
  }
  if (!resume) {
    if (queueLease) session.followUps.release(queueLease, 'recoverable');
    // Nothing came back, which is several facts in one `null`: the checkpoint
    // is gone, the record could not be read — a torn read of the rewrite the
    // process that owns this run is making right now parses as absent — or the
    // file is there and holds no state this category can resume. Ownership is
    // what the lease alone settles, so the refusal is decided first by
    // `classifyRun` and recorded through the same mapping the follow-up path
    // uses: a run held elsewhere refreshes the hold instead of dropping it and
    // being reported finished.
    const classification = await classifyRun(executionId);
    const failed = recordRunRefusal(streamId, session, classification);
    if (
      classification.kind === 'held_elsewhere' ||
      classification.kind === 'owned_here'
    ) {
      return { failed };
    }
    // Nobody holds it, so the checkpoint file is what is left to word from.
    // History listings advertise a row from that file alone (one `stat`,
    // never a parse), so a record this category rejected and a malformed one
    // both meet a refusal worded as unusable state rather than as a run that
    // finished. Only `checkpoint-malformed` names the file itself; every
    // other fault is a read that says nothing about it.
    const unusable =
      classification.kind === 'unclassified'
        ? classification.fault === 'checkpoint-malformed'
        : await checkpointExists(executionId);
    if (!unusable) return { failed };
    log.warn(
      `Refusing to resume ${executionId}: its checkpoint holds no resumable state.`,
    );
    return { failed: 'unusable_checkpoint' };
  }
  // Both branches below launch only when the checkpoint's category and the
  // queue lease agree; a disagreement refuses, so no host rearranges for it.
  const willLaunch = (resume.type === 'toolUse') === (queueLease !== undefined);
  // One lease read per open, taken before the hold below is touched: a read
  // that fails leaves the earlier refusal's hold standing, since this attempt
  // learned nothing that disproves it. The hook is where a host rearranges
  // itself onto the resumed run, so a row another TeXRA process is live on
  // must refuse before that, not after the launch's own acquire raises
  // `ExecutionLeaseActiveError` onto a cleared window. The acquire still
  // settles the race this read cannot see.
  const lease =
    willLaunch && options.onResumeResolved
      ? await inspectExecutionLease(executionId).catch((error: unknown) => {
          if (queueLease) session.followUps.release(queueLease, 'recoverable');
          throw error;
        })
      : undefined;
  // The run is about to be opened for write, its checkpoint just re-read. A
  // hold recorded by an earlier refusal describes facts this
  // attempt has now re-read, so it goes, and the phase it retained goes with
  // it — a failed tool-use resume rolls the stream back to WAITING before the
  // hold is written, and this read has disproved that WAITING. An attempt
  // refused below writes the current reason; one that acquires leaves the
  // phase it lands on.
  session.status.clearHold(streamId, { discardRetainedPhase: true });
  if (lease?.status === 'held') {
    if (queueLease) session.followUps.release(queueLease, 'recoverable');
    session.status.markUnavailableOrLog(
      streamId,
      streamHeldMessage(lease.owner.pid),
      log,
    );
    return { failed: 'owned_elsewhere' };
  }
  if (willLaunch && options.onResumeResolved) {
    try {
      await options.onResumeResolved();
    } catch (error) {
      if (queueLease) session.followUps.release(queueLease, 'recoverable');
      throw error;
    }
    if (
      isCancellationRequested() ||
      session.executions.isActiveOrResuming(streamId)
    ) {
      if (queueLease) session.followUps.release(queueLease, 'recoverable');
      return REFUSED;
    }
  }
  if (resume.type === 'toolUse' && queueLease) {
    return resumeQueuedToolUse(session, resume, queueLease, options);
  }
  if (resume.type === 'workflow' && !queueLease) {
    try {
      await options.executeWorkflow(
        resume.agentConfig,
        resume.executionId,
        resume.modelHandlerCompatibilityKey,
      );
    } catch (error) {
      return refusalFor(error, session, streamId) ?? Promise.reject(error);
    }
    return WORKFLOW_STARTED;
  }
  // The persisted config and checkpoint disagree on the category.
  if (queueLease) session.followUps.release(queueLease, 'recoverable');
  return REFUSED;
}

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
  if (error instanceof ExecutionLeaseActiveError) {
    session.status.markUnavailableOrLog(
      streamId,
      streamHeldMessage(error.owner.pid),
      log,
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
async function resumeQueuedToolUse(
  session: SessionHandle,
  resume: ToolUseResumeData,
  queueLease: FollowUpRecoveryLease,
  options: ResumeRunOptions,
): Promise<ResumeRunResult> {
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
  let resumeError: { error: unknown } | undefined;
  let runResult: AgentRuntimeFlowResult | undefined;
  const notifyQueued = (): void => {
    session.events.emit({
      scope: 'session',
      event: { type: 'updateQueuedFollowUps', payload: { streamId } },
    });
  };
  const restoreFollowUps = (): void => {
    if (followUpsRestored) return;
    followUpsRestored = true;
    followUpsQueue.queue(queueLease).restore(followUps);
    if (followUps.length > 0) notifyQueued();
  };
  try {
    options.onFollowUpQueueReady?.(queueLease);
    followUps = [...seed, ...followUpsQueue.queue(queueLease).drainItems()];
    notifyQueued();

    // The drained batch must reach the resumed flow through the direct
    // `drainedFollowUps` handoff, not by re-queuing: a subagent's WAITING
    // cursor suspends again before ever reading the stream queue (see
    // `ToolUseWaitNode`; only its child-run loop's queue wait consumes it),
    // so re-queued items would sit unconsumed until the next wake. A root
    // cursor accepts either route; the handoff works for both.
    runResult = await resumeToolUseFromResumeData(resume, {
      session: options.session,
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
    if (followUps.length > 0) restoreFollowUps();
  } catch (error) {
    resumeError = { error };
    // A rejection before the wait node acknowledges consumption must replay
    // the drained batch. A callback failure after that acknowledgement must
    // not enqueue the same user input again.
    if (followUps.length > 0) restoreFollowUps();
  } finally {
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
  }

  if (resumeError) {
    return (
      refusalFor(resumeError.error, session, streamId) ??
      Promise.reject(resumeError.error)
    );
  }
  // Cancellation at flow attachment means the run was never reached; a replay
  // means it ran and returned with the batch back on the stream queue.
  if (cancelledAtFlowAttachment) return REFUSED;
  return {
    started: true,
    delivered: !followUpsRestored,
    outcome: runResult?.outcome,
  };
}

function toFollowUpBatchItem(item: FollowUpQueueInput): FollowUpQueueBatchItem {
  return {
    text: item.text,
    displayText: item.displayText,
    mediaFiles: item.mediaFiles,
    origin: item.origin ?? 'user',
  };
}
