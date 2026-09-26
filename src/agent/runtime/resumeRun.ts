import { Cause, Deferred, Effect, Exit, Fiber, Result } from 'effect';

/**
 * The one resume entry point. Every host continues a persisted run through
 * it, including implicit follow-up wakes. It claims recovery and launches
 * on the run lane. Recovered children use the same continuous delivery driver
 * as newly launched children and acknowledge each resumed turn separately.
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
import { getRunRecords, persistedParentRunId } from '@agent/storage/runRecords';
import { withLogChannel } from '@logger/effectLog';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { ProcessServices } from '@platform/processRuntime';
import {
  aggregateId,
  AgentCategory,
  ownerPid,
  RUN_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type ModelCompatibilityKey,
  type RunId,
} from '@shared/schemas';
import { runHeldMessage } from '@shared/runs/runStatusDisplay';
import { claimStanding, heldElsewhereBy } from '@shared/session/database';
import { RunLedgerRefused } from '@shared/session/runLedger';
import { foldRunRows } from '@shared/session/runRows';
import { createNativeSubagentStrategy } from '@tools/delegation/nativeSubagentStrategy';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { type AgentFlowResult } from './AgentFlowResult';
import {
  ResumeSessionUnavailableError,
  resumeToolUseFromResumeData,
  type SubagentRunOptions,
} from './executeAgent';
import { classifyRun } from './runClassification';
import { startChildRunLoop } from './childRunLoop';
import { Runs } from './runRegistry';
import { RunLive } from './runRegistry';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from './SessionResumeRetrieval';
import type { SessionHandle } from './SessionHandle';
import type { AgentRunServices } from './runRegistry';

type ResumeRunCompletion = Effect.Effect<AgentFlowResult['outcome'], Error>;
/** A resume settles at the run's idle turn or at run termination, after admitted input is consumed. */
export type ResumeRunResult =
  | {
      readonly started: true;
      readonly delivered: boolean;
      readonly outcome?: AgentFlowResult['outcome'] | typeof RUN_PHASE.WAITING;
      /** A root's lifetime past its idle acknowledgement; children have none. */
      readonly completion?: ResumeRunCompletion;
    }
  | { readonly failed: FollowUpFailureReason };

export interface ResumeRunOptions extends Pick<
  SubagentRunOptions,
  'approvalPromptsUnavailable' | 'onApprovalPolicyDenial'
> {
  /** Session owning the resumed run's coordination state. */
  readonly session: SessionHandle;
  /** Recovery ownership synchronously claimed by the submission boundary. */
  readonly recovery?: RecoveryContinuation;
  /** Monotone per-attempt cancellation signal: once true it stays true. */
  readonly isCancellationRequested?: () => boolean;
  /**
   * Input behind the run's existing queue. It remains the caller's until
   * {@link onFollowUpQueueReady}; refusals before that point must restore it.
   * Afterwards untaken input stays durable on the run (`delivered: false`).
   */
  readonly extraFollowUps?: readonly FollowUpQueueInput[];
  /**
   * Fires once the recovery lease is held and `extraFollowUps` are queued
   * on the run, before the resumed generation launches: the one signal that
   * the run has taken ownership of them.
   */
  readonly onFollowUpQueueReady?: (recovery: FollowUpRecoveryLease) => void;
  /**
   * Rearrange the host only after state retrieval and ownership checks have
   * accepted this run. Failures propagate; cancellation is re-read afterwards.
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
  if (options.isCancellationRequested?.() === true) return REFUSED;
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

const CHANNEL = 'ResumeRun';

const REFUSED: ResumeRunResult = { failed: 'not_resumable' };
/** A workflow run carries no follow-up batch, so nothing awaits delivery. */
const WORKFLOW_STARTED: ResumeRunResult = { started: true, delivered: true };

/**
 * Only a ledger refusal of the saved rows names an unusable checkpoint.
 * Ownership, metadata and lease failures remain operational errors.
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
  const cancelled = () => options.isCancellationRequested?.() === true;
  // Revalidate the continuation when abandoning a lease after storage reads.
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
  if (cancelled()) {
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
  if (cancelled()) {
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
    if (cancelled()) {
      releaseQueue();
      return REFUSED;
    }
  }
  // The category check above ensures every tool-use resume holds a lease.
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

/** The follow-ups still queued on the run, folded from its durable rows. */
const queuedFollowUps = (session: SessionHandle, runId: RunId) =>
  Effect.flatMap(session.readAggregate(aggregateId('run', runId)), (rows) =>
    Effect.try({ try: () => foldRunRows(rows).followUps, catch: ensureError }),
  );

const warnUnreadable = (runId: RunId, failure: unknown): Effect.Effect<void> =>
  Effect.logWarning(
    `Run ${runId}: its queued follow-ups could not be read; keeping it recoverable`,
  ).pipe(Effect.annotateLogs({ data: failure }), withLogChannel(CHANNEL));

/**
 * Give back recovery no generation took over. Empty provisional leases end
 * the entry; durable queued input or an unreadable fold keeps it recoverable.
 */
const releaseUnstartedRecovery = Effect.fn('releaseUnstartedRecovery')(
  function* (
    session: SessionHandle,
    recovery: RecoveryContinuation,
    provisional: boolean,
  ) {
    if (!session.followUps.useRecovery(recovery)) return;
    const queued =
      !provisional ||
      (yield* queuedFollowUps(session, recovery.runId).pipe(
        Effect.map((followUps) => followUps.length > 0),
        Effect.catch((failure) =>
          warnUnreadable(recovery.runId, failure).pipe(Effect.as(true)),
        ),
      ));
    const current = session.followUps.useRecovery(recovery);
    if (!current) return;
    if (!queued) {
      session.followUps.terminalize(current.runId);
      return;
    }
    session.followUps.release(current, 'recoverable');
  },
);

/** Classify the expected launch refusals; unexpected failures propagate. */
function refusalFor(
  error: unknown,
  session: SessionHandle,
  runId: RunId,
): Effect.Effect<ResumeRunResult | undefined> {
  if (error instanceof RunLive) return Effect.succeed(REFUSED);
  // A live owner refused the claim, or took it after its owner was proved dead.
  const holder = heldElsewhereBy(error);
  if (holder !== null) {
    return session
      .markUnreadable(runId, runHeldMessage(ownerPid(holder)))
      .pipe(Effect.as({ failed: 'owned_elsewhere' } as const));
  }
  if (error instanceof ResumeSessionUnavailableError) {
    return Effect.succeed({ failed: 'finished' });
  }
  if (namesUnusableCheckpoint(error)) {
    return Effect.logWarning(
      `Refusing to resume ${runId}: its saved state cannot be continued: ${toErrorMessage(error)}`,
    ).pipe(
      Effect.annotateLogs({ data: error }),
      withLogChannel(CHANNEL),
      Effect.as({ failed: 'unusable_checkpoint' } as const),
    );
  }
  return Effect.succeed(undefined);
}

/**
 * Admit input under recovery, then launch. The launched run owns the queue
 * (a child through its delivery driver, a root through its own exit) and
 * acknowledges this batch at its first idle turn without ending its lifetime.
 */
const resumeQueuedToolUse = Effect.fn('resumeQueuedToolUse')(function* (
  session: SessionHandle,
  resume: ToolUseResumeData,
  queueLease: FollowUpRecoveryLease,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeRunResult, Error, AgentRunServices> {
  const runId = resume.runId;
  const followUps = session.followUps;

  // Do not revive a generation while its stop is settling: a live roster
  // entry is a run whose fiber has not settled yet.
  if ((yield* Runs).isLive(resume.runId)) {
    followUps.release(queueLease, 'recoverable');
    return REFUSED;
  }

  let cancelledAtFlowAttachment = false;
  let runOwnsQueue = false;
  let rootCompletion: ResumeRunCompletion | undefined;
  const admitted = new Set<string>();
  const isAdmitted = (input: { readonly followUpId: string }): boolean =>
    admitted.has(input.followUpId);
  const queuedInput = queuedFollowUps(session, runId);
  // A root holds no lease of its own: its exit releases this one by the rows.
  const releaseRecovery = (exit: Exit.Exit<AgentFlowResult, Error>) =>
    queuedInput.pipe(
      Effect.map((queued) => queued.length > 0),
      Effect.catchCause((cause) =>
        warnUnreadable(runId, Cause.squash(cause)).pipe(Effect.as(true)),
      ),
      Effect.map((queued) =>
        followUps.release(
          queueLease,
          Exit.isSuccess(exit) && !queued ? 'terminal' : 'recoverable',
        ),
      ),
    );
  const resumed = yield* Effect.result(
    Effect.gen(function* () {
      // Admit the whole batch atomically, or leave it with the caller.
      const extra = options.extraFollowUps ?? [];
      if (extra.length > 0) {
        const submitted = yield* followUps.submitBatch(
          runId,
          extra,
          'live_owner',
        );
        if (submitted.kind === 'refused') return 'owned_elsewhere' as const;
      }
      yield* Effect.try({
        try: () => options.onFollowUpQueueReady?.(queueLease),
        catch: ensureError,
      });
      for (const input of yield* queuedInput) admitted.add(input.followUpId);
      const idle = yield* Deferred.make<void>();
      const launchOptions = {
        session,
        approvalPromptsUnavailable: options.approvalPromptsUnavailable,
        onApprovalPolicyDenial: options.onApprovalPolicyDenial,
        isCancellationRequested: options.isCancellationRequested,
        onCancellationAtFlowAttachment: () => {
          cancelledAtFlowAttachment = true;
        },
      };
      const onIdle = (): void => {
        if (!session.pendingFollowUps(runId).some(isAdmitted))
          Deferred.doneUnsafe(idle, Effect.void);
      };
      const parentRunId = yield* persistedParentRunId(session, runId);
      let completion: Fiber.Fiber<AgentFlowResult | undefined, Error>;
      if (parentRunId === undefined) {
        const root = yield* Effect.forkDetach(
          resumeToolUseFromResumeData(resume, {
            ...launchOptions,
            onIdle,
          }).pipe(Effect.onExit(releaseRecovery)),
        );
        rootCompletion = Fiber.join(root).pipe(Effect.map((r) => r.outcome));
        completion = root;
      } else {
        completion = yield* startChildRunLoop({
          session,
          runId,
          parentRunId,
          queueLease,
          agentName: resume.agentConfig.agent,
          budgeted: true,
          strategy: createNativeSubagentStrategy({
            ...launchOptions,
            runId,
            parentRunId,
            startedAt: Date.now(),
            workingDirectory: resume.agentConfig.workingDirectory ?? undefined,
            userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
            resume: { identity: resume, options: { ...launchOptions, onIdle } },
          }),
        });
      }
      // The run owns this queue until termination. Interrupting either
      // observation below cannot interrupt that transferred run lifetime.
      runOwnsQueue = true;
      return yield* Effect.raceFirst(
        Deferred.await(idle).pipe(
          Effect.as(RUN_PHASE.WAITING),
          Effect.interruptible,
        ),
        Fiber.join(completion).pipe(Effect.interruptible),
      );
    }),
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!runOwnsQueue) followUps.release(queueLease, 'recoverable');
      }),
    ),
  );
  if (Result.isFailure(resumed)) {
    const refusal = yield* refusalFor(resumed.failure, session, runId);
    if (refusal) return refusal;
    return yield* Effect.fail(resumed.failure);
  }
  const settled = resumed.success;
  if (settled === 'owned_elsewhere') return { failed: settled };
  if (cancelledAtFlowAttachment) return REFUSED;
  const waiting = settled === RUN_PHASE.WAITING;
  const undelivered =
    runOwnsQueue && !waiting && (yield* queuedInput).some(isAdmitted);
  return {
    started: true,
    delivered: !undelivered,
    outcome: waiting ? settled : settled?.outcome,
    ...(rootCompletion && { completion: rootCompletion }),
  };
});
