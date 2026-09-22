import { Deferred, Effect, Fiber, Result } from 'effect';

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
import {
  claimStanding,
  DatabaseClaimRefused,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { RunLedgerRefused } from '@shared/session/runLedger';
import { foldRunState } from '@shared/session/runStateFold';
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
import { RunLive } from './runRoster';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from './SessionResumeRetrieval';
import type { SessionHandle } from './SessionHandle';
import type { AgentRunServices } from './toolInjection';

/** A resume settles at a child's idle turn or at run termination, after admitted input is consumed. */
export type ResumeRunResult =
  | {
      readonly started: true;
      readonly delivered: boolean;
      readonly outcome?: AgentFlowResult['outcome'] | typeof RUN_PHASE.WAITING;
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
    const warnUnreadable = (failure: unknown): Effect.Effect<void> =>
      Effect.logWarning(
        `Run ${recovery.runId}: its queued follow-ups could not be read; keeping it recoverable`,
      ).pipe(Effect.annotateLogs({ data: failure }), withLogChannel(CHANNEL));
    let queued = true;
    if (provisional) {
      const rows = yield* Effect.result(
        session.readAggregate(aggregateId('run', recovery.runId)),
      );
      if (Result.isFailure(rows)) {
        yield* warnUnreadable(rows.failure);
      } else {
        const folded = foldRunState(null, rows.success);
        if (Result.isSuccess(folded)) {
          queued = (folded.success?.followUps.length ?? 0) > 0;
        } else {
          yield* warnUnreadable(folded.failure);
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

/** Classify the expected launch refusals; unexpected failures propagate. */
function refusalFor(
  error: unknown,
  session: SessionHandle,
  runId: RunId,
): Effect.Effect<ResumeRunResult | undefined> {
  if (error instanceof RunLive) return Effect.succeed(REFUSED);
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
 * Admit input under recovery, then launch. Child drivers take queue ownership;
 * their first idle turn acknowledges this batch without ending their lifetime.
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
  let refusedElsewhere = false;
  let runResult: AgentFlowResult | undefined;
  let undelivered = false;
  let childOwnsQueue = false;
  let childWaiting = false;
  let admittedInputIds: ReadonlySet<string> | undefined;
  const queuedInput = Effect.gen(function* () {
    const folded = foldRunState(
      null,
      yield* session.readAggregate(aggregateId('run', runId)),
    );
    if (Result.isFailure(folded)) return yield* Effect.fail(folded.failure);
    return folded.success?.followUps ?? [];
  });
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
        if (submitted.kind === 'refused') {
          refusedElsewhere = true;
          return undefined;
        }
      }
      yield* Effect.try({
        try: () => options.onFollowUpQueueReady?.(queueLease),
        catch: ensureError,
      });
      const launchOptions = {
        session,
        approvalPromptsUnavailable: options.approvalPromptsUnavailable,
        onApprovalPolicyDenial: options.onApprovalPolicyDenial,
        runtimeUnavailableTools: options.runtimeUnavailableTools,
        isCancellationRequested: options.isCancellationRequested,
        onCancellationAtFlowAttachment: () => {
          cancelledAtFlowAttachment = true;
        },
      };
      const parentRunId = yield* persistedParentRunId(session, runId);
      if (parentRunId === undefined)
        return yield* resumeToolUseFromResumeData(resume, launchOptions);
      admittedInputIds = new Set(
        (yield* queuedInput).map((input) => input.followUpId),
      );
      const idle = yield* Deferred.make<void>();
      const completion = yield* startChildRunLoop({
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
          agentName: resume.agentConfig.agent,
          startedAt: Date.now(),
          workingDirectory: resume.agentConfig.workingDirectory ?? undefined,
          userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
          resume: {
            identity: resume,
            options: {
              ...launchOptions,
              onIdle: (state) => {
                if (
                  !state.followUps.some((input) =>
                    admittedInputIds!.has(input.followUpId),
                  )
                )
                  Deferred.doneUnsafe(idle, Effect.void);
              },
            },
          },
        }),
      });
      // The driver owns this queue until termination. Interrupting either
      // observation below cannot interrupt that transferred run lifetime.
      childOwnsQueue = true;
      return yield* Effect.raceFirst(
        Deferred.await(idle).pipe(
          Effect.as(undefined),
          Effect.tap(() =>
            Effect.sync(() => {
              childWaiting = true;
            }),
          ),
          Effect.interruptible,
        ),
        Fiber.join(completion).pipe(Effect.interruptible),
      );
    }),
  ).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (Result.isSuccess(result)) runResult = result.success;
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (childOwnsQueue) return;
        undelivered = followUps.hasQueued(queueLease);
        followUps.release(
          queueLease,
          !runResult || undelivered ? 'recoverable' : 'terminal',
        );
      }),
    ),
  );
  if (Result.isFailure(resumed)) {
    const refusal = yield* refusalFor(resumed.failure, session, runId);
    if (refusal) return refusal;
    return yield* Effect.fail(resumed.failure);
  }
  if (refusedElsewhere) return { failed: 'owned_elsewhere' };
  if (cancelledAtFlowAttachment) return REFUSED;
  if (childOwnsQueue && !childWaiting)
    undelivered = (yield* queuedInput).some((input) =>
      admittedInputIds!.has(input.followUpId),
    );
  return {
    started: true,
    delivered: !undelivered,
    outcome: childWaiting ? RUN_PHASE.WAITING : runResult?.outcome,
  };
});
