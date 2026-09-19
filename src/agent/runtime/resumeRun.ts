import { Effect, Result } from 'effect';

/**
 * The one resume entry point. Every host continues a persisted run through
 * it: the extension toolbar, the desktop bridge, the CLI `/resume` command and
 * `texra resume`, and the implicit follow-up wake. It resolves persisted
 * state, claims the stream's follow-up recovery lease, and launches the run
 * as a generation on its run lane (`resumeToolUseFromResumeData` for
 * tool-use, the host's workflow launcher for workflows). The native child
 * loop keeps the unlaned `resumeToolUseTurn`: it already holds the lane.
 */
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  recordRunRefusal,
  type FollowUpFailureReason,
} from '@agent/followUp/ToolUseFollowUp';
import type {
  FollowUpQueueInput,
  FollowUpRecoveryLease,
} from '@agent/followUp/ToolUseFollowUpQueueManager';
import { getRunRecords } from '@agent/storage/runRecords';
import { createLog } from '@logger/logUtils';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { ProcessServices } from '@platform/processRuntime';
import {
  aggregateId,
  AgentCategory,
  ownerPid,
  type ModelCompatibilityKey,
  type RunId,
} from '@shared/schemas';
import { runHeldMessage } from '@shared/runs/runStatusDisplay';
import {
  claimStanding,
  DatabaseClaimRefused,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { RunLedgerRefused } from '@shared/session/runLedger';
import { foldRunState } from '@shared/session/runStateFold';
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
import { Runs } from './runRegistry';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from './SessionResumeRetrieval';
import type { SessionHandle } from './SessionHandle';
import type { AgentRunServices } from './toolInjection';

/**
 * `started` once the resumed generation has settled (a tool-use turn parked
 * at WAITING or finished; a workflow run returned). `delivered` is false when
 * that generation returned with input still in its queue: the follow-ups
 * stay queued on the run's rows and await delivery, so a follow-up wake
 * reports them as queued while an explicit resume settles the turn it just
 * ran. `outcome` carries the resumed tool-use run's
 * raw result (terminal or WAITING), absent on the workflow path and when the
 * run never returned one. A refusal carries the reason a host words with
 * `describeFollowUpFailure`. Unexpected failures (storage errors, the run
 * itself failing) reach the caller's failure channel.
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
  | 'approvalPromptsUnavailable'
  | 'onApprovalPolicyDenial'
  | 'runtimeUnavailableTools'
> {
  /** Session owning the resumed run's coordination state. */
  readonly session: SessionHandle;
  /** Recovery ownership synchronously claimed by the submission boundary. */
  readonly recovery?: RecoveryContinuation;
  /** Monotone per-attempt cancellation signal: once true it stays true. */
  readonly isCancellationRequested?: () => boolean;
  /**
   * Follow-ups to queue for the run behind what its rows already queue (e.g.
   * an explicit follow-up typed alongside a manual resume).
   *
   * The batch stays the caller's until {@link onFollowUpQueueReady} fires:
   * every refusal before that point returns it unqueued, and the caller must
   * put it back where it came from or the user's input is lost. Once queued
   * it belongs to the run: a generation that returns without taking it
   * leaves it queued (`delivered: false`) rather than back with the caller.
   */
  readonly extraFollowUps?: readonly FollowUpQueueInput[];
  /**
   * Fires once the recovery lease is held and `extraFollowUps` are queued
   * on the run, before the resumed generation launches: the one signal that
   * the run has taken ownership of them.
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
   * with the user's window untouched. A failure propagates to the caller; a
   * stop requested while it runs is honored, because
   * {@link isCancellationRequested} is re-read once it returns.
   */
  readonly onResumeResolved?: () => Effect.Effect<void, Error, ProcessServices>;

  /**
   * Workflow launch owns stream acquisition and status transitions through
   * `runAgent`; each host supplies its own launcher.
   */
  readonly executeWorkflow: (
    config: AgentConfig,
    runId: RunId,
    modelCompatibilityKey: ModelCompatibilityKey | null | undefined,
  ) => Effect.Effect<void, Error, ProcessServices>;
}

/**
 * Resume a stream through the single host entry path. Recovery is claimed
 * when the program starts, before the stream-to-run index performs I/O. The
 * resume is on the session's `Runs`, provided here from that one session.
 */
export const resumeClaimedRun = Effect.fn('resumeClaimedRun')(function* (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeRunResult, Error, ProcessServices> {
  const session = options.session;
  const { runs } = session;
  if (
    options.isCancellationRequested?.() === true ||
    runs.isActiveOrResuming(runId)
  )
    return REFUSED;
  const recovery = options.recovery
    ? session.followUps.useRecovery(options.recovery)
    : session.followUps.claimRecovery(runId, true);
  if (!recovery || recovery.runId !== runId) {
    if (recovery) session.followUps.release(recovery, 'recoverable');
    return REFUSED;
  }
  return yield* resumeRunWithRecoveryProvenance(
    runId,
    { ...options, recovery },
    options.recovery == null,
  ).pipe(Effect.provideService(Runs, runs));
}, Effect.uninterruptible);

const log = createLog('ResumeRun');

const REFUSED: ResumeRunResult = { failed: 'not_resumable' };
/** A workflow run carries no follow-up batch, so nothing awaits delivery. */
const WORKFLOW_STARTED: ResumeRunResult = { started: true, delivered: true };

/**
 * Positive evidence that the run's saved state itself is what failed, walking
 * the cause chain the launch wraps its failures in: the ledger refused the
 * run's rows (`inconsistent`, `unprepared-history`) at the fold that would
 * continue them. A `not-owner` refusal and every other failure on the resume
 * path — a KV or metadata read, a lease read — stay the operational error
 * the host words with its cause.
 */
function namesUnusableCheckpoint(error: unknown): boolean {
  for (let current = error, depth = 0; depth < 8; depth++) {
    if (current instanceof RunLedgerRefused) {
      return (
        current.reason === 'inconsistent' ||
        current.reason === 'unprepared-history'
      );
    }
    if (!(current instanceof Error) || current.cause === undefined)
      return false;
    current = current.cause;
  }
  return false;
}

// The existing host cancellation predicate controls the launch.
// Keep its queue owner until that launch and its cleanup have settled.
export const resumeRun = Effect.fn('resumeRun')(function* (
  runId: RunId,
  options: ResumeRunOptions,
) {
  return yield* resumeRunWithRecoveryProvenance(runId, options, false).pipe(
    Effect.provideService(Runs, options.session.runs),
  );
}, Effect.uninterruptible);

/** Resume preparation is one ordered program; checkpoint interpretation is unchanged. */
const resumeRunWithRecoveryProvenance = Effect.fn(
  'resumeRunWithRecoveryProvenance',
)(function* (
  runId: RunId,
  options: ResumeRunOptions,
  recoveryIsProvisional: boolean,
): Effect.fn.Return<ResumeRunResult, Error, AgentRunServices> {
  const session = options.session;
  const runs = yield* Runs;
  const cancelled = () => options.isCancellationRequested?.() === true;
  // `releaseUnstartedRecovery` revalidates the continuation against the
  // boundary itself, so a lease that stopped being the entry's owner while
  // this program was reading the run gives back nothing, as before.
  const supplied = options.recovery;
  const abandonSupplied = (provisional = recoveryIsProvisional) =>
    supplied
      ? releaseUnstartedRecovery(session, supplied, provisional)
      : Effect.void;
  const store = getRunRecords(session, runId);
  const [config, exists] = yield* Effect.all([
    store.readConfig(),
    store.exists(),
  ]).pipe(Effect.onError(() => abandonSupplied()));
  if (!config || !exists) {
    yield* abandonSupplied();
    return REFUSED;
  }
  if (supplied && supplied.runId !== runId) {
    yield* abandonSupplied(false);
    return REFUSED;
  }
  if (cancelled() || runs.isActiveOrResuming(runId)) {
    yield* abandonSupplied();
    return REFUSED;
  }
  // Claim before retrieval so concurrent follow-ups join this attempt's queue.
  let queueLease: FollowUpRecoveryLease | undefined;
  if (config.agentCategory === AgentCategory.ToolUse) {
    queueLease = options.recovery
      ? session.followUps.useRecovery(options.recovery)
      : session.followUps.claimRecovery(runId, true);
    if (!queueLease) return REFUSED;
  } else {
    yield* abandonSupplied();
  }
  const releaseQueue = (): void => {
    if (queueLease) session.followUps.release(queueLease, 'recoverable');
  };
  const retrieved = yield* Effect.result(
    retrieveSessionResumeData(runId, config, session),
  );
  if (Result.isFailure(retrieved)) {
    releaseQueue();
    return yield* Effect.fail(retrieved.failure);
  }
  const resume = retrieved.success;
  if (cancelled() || runs.isActiveOrResuming(runId)) {
    releaseQueue();
    return REFUSED;
  }
  if (!resume) {
    releaseQueue();
    const classification = yield* classifyRun(runId, session);
    return { failed: yield* recordRunRefusal(runId, session, classification) };
  }
  const claim = options.onResumeResolved
    ? yield* session
        .claimOwner(runId)
        .pipe(Effect.onError(() => Effect.sync(releaseQueue)))
    : undefined;
  yield* session.clearUnreadable(runId);
  // A claim whose owner is this process, or provably dead, is one the resume
  // takes over; anything else is another live TeXRA process's run.
  const standing = claim && claimStanding(claim);
  if (standing?.kind === 'held') {
    releaseQueue();
    yield* session.markUnreadable(
      runId,
      runHeldMessage(ownerPid(standing.owner)),
    );
    return { failed: 'owned_elsewhere' };
  }
  if (options.onResumeResolved) {
    yield* options
      .onResumeResolved()
      .pipe(Effect.onError(() => Effect.sync(releaseQueue)));
    if (cancelled() || runs.isActiveOrResuming(runId)) {
      releaseQueue();
      return REFUSED;
    }
  }
  // The lease above and the resume type below are the same fact read twice:
  // both come from `config.agentCategory`, so a tool-use run always holds a
  // lease here and the workflow arm is the fallthrough.
  if (resume.type === 'toolUse' && queueLease) {
    return yield* resumeQueuedToolUse(session, resume, queueLease, options);
  }
  const launched = yield* Effect.result(
    options.executeWorkflow(
      resume.agentConfig,
      resume.runId,
      resume.modelCompatibilityKey,
    ),
  );
  if (Result.isFailure(launched)) {
    const refused = yield* refusalFor(launched.failure, session, runId);
    if (refused) return refused;
    return yield* Effect.fail(launched.failure);
  }
  return WORKFLOW_STARTED;
});

/**
 * Give back a recovery lease no generation took over. A provisional lease
 * (one this attempt claimed for itself) over a run whose rows queue nothing
 * ends the run's entry; a run with queued follow-ups stays recoverable, so
 * the next wake can deliver them. The rows are read from the run-state fold,
 * not from memory: follow-ups an earlier generation left queued are there
 * and nowhere else. A fold that cannot be read keeps the run recoverable,
 * and says so.
 */
const releaseUnstartedRecovery = Effect.fn('releaseUnstartedRecovery')(
  function* (
    session: SessionHandle,
    recovery: RecoveryContinuation,
    provisional: boolean,
  ) {
    if (!session.followUps.useRecovery(recovery)) return;
    const warnUnreadable = (failure: unknown): void =>
      log.warn(
        `Run ${recovery.runId}: its queued follow-ups could not be read; keeping it recoverable`,
        { data: failure },
      );
    let queued = true;
    if (provisional) {
      const rows = yield* Effect.result(
        session.readAggregate(aggregateId('run', recovery.runId)),
      );
      if (Result.isFailure(rows)) {
        warnUnreadable(rows.failure);
      } else {
        const folded = foldRunState(null, rows.success);
        if (Result.isSuccess(folded)) {
          queued = (folded.success?.followUps.length ?? 0) > 0;
        } else {
          warnUnreadable(folded.failure);
        }
      }
    }
    const current = session.followUps.useRecovery(recovery);
    if (!current) return;
    if (!queued) {
      session.followUps.terminalize(current.runId);
      return;
    }
    session.followUps.release(current, 'recoverable');
  },
);

/**
 * The two expected launch failures a host words; anything else fails.
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
  runId: RunId,
): Effect.Effect<ResumeRunResult | undefined> {
  if (
    error instanceof DatabaseWriteFailed &&
    error.cause instanceof DatabaseClaimRefused
  ) {
    return session
      .markUnreadable(runId, runHeldMessage(ownerPid(error.cause.ownerId)))
      .pipe(Effect.as({ failed: 'owned_elsewhere' } as const));
  }
  if (error instanceof ResumeSessionUnavailableError) {
    return Effect.succeed({ failed: 'finished' });
  }
  if (namesUnusableCheckpoint(error)) {
    return Effect.sync(() => {
      log.warn(
        `Refusing to resume ${runId}: its saved state cannot be continued: ${toErrorMessage(error)}`,
        { data: error },
      );
      return { failed: 'unusable_checkpoint' } as const;
    });
  }
  return Effect.succeed(undefined);
}

/**
 * Resume a tool-use run under its recovery lease: queue the caller's extra
 * follow-ups on the run, then launch the resumed generation, which seeds its
 * queue from the run's rows. The phase is the fold's: the resume's
 * `run.activate` reads as resuming, and a resume that never reached the
 * lifecycle leaves the run to read as interrupted once its claim is released.
 */
const resumeQueuedToolUse = Effect.fn('resumeQueuedToolUse')(function* (
  session: SessionHandle,
  resume: ToolUseResumeData,
  queueLease: FollowUpRecoveryLease,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeRunResult, Error, AgentRunServices> {
  const runId = resume.runId;
  const followUps = session.followUps;

  if ((yield* Runs).getHandle(resume.runId)?.suspendedTerminationStarted) {
    followUps.release(queueLease, 'recoverable');
    return REFUSED;
  }

  let cancelledAtFlowAttachment = false;
  let refusedElsewhere = false;
  let runResult: AgentRuntimeFlowResult | undefined;
  let undelivered = false;
  const resumed = yield* Effect.result(
    Effect.gen(function* () {
      // The batch is one admission and one transaction: queued whole, or
      // refused (another process holds the run) with nothing written, so it
      // stays the caller's.
      const extra = options.extraFollowUps ?? [];
      if (extra.length > 0) {
        const submitted = yield* followUps.submitBatch(
          runId,
          extra,
          'live_owner',
        );
        if (submitted.kind === 'refused') {
          refusedElsewhere = true;
          return undefined;
        }
      }
      yield* Effect.try({
        try: () => options.onFollowUpQueueReady?.(queueLease),
        catch: ensureError,
      });
      return yield* resumeToolUseFromResumeData(resume, {
        session,
        approvalPromptsUnavailable: options.approvalPromptsUnavailable,
        onApprovalPolicyDenial: options.onApprovalPolicyDenial,
        runtimeUnavailableTools: options.runtimeUnavailableTools,
        isCancellationRequested: options.isCancellationRequested,
        onCancellationAtFlowAttachment: () => {
          cancelledAtFlowAttachment = true;
        },
      });
    }),
  ).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (Result.isSuccess(result)) runResult = result.success;
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        undelivered = followUps.hasQueued(queueLease);
        followUps.release(
          queueLease,
          !runResult || isWaitingFlowResult(runResult) || undelivered
            ? 'recoverable'
            : 'terminal',
        );
      }),
    ),
  );
  if (Result.isFailure(resumed)) {
    const refusal = yield* refusalFor(resumed.failure, session, runId);
    if (refusal) return refusal;
    return yield* Effect.fail(resumed.failure);
  }
  // Another live process holds the run: nothing was queued or launched.
  if (refusedElsewhere) return { failed: 'owned_elsewhere' };
  // Cancellation at flow attachment means the run was never reached; input
  // left queued means it ran and returned before taking it.
  if (cancelledAtFlowAttachment) return REFUSED;
  return {
    started: true,
    delivered: !undelivered,
    outcome: runResult?.outcome,
  };
});
