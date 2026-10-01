import { Cause, Clock, Deferred, Effect, Exit, Fiber, Result } from 'effect';

/**
 * The one resume entry point. Every host continues a persisted run through
 * it, including implicit follow-up wakes. It claims recovery (the wake an
 * admission reserved, or a fresh one), gives back whatever the launched run
 * did not take over, and launches on the run lane. Recovered children use
 * the same continuous delivery driver as newly launched children and
 * acknowledge each resumed turn separately.
 */
import {
  recordRunRefusal,
  type FollowUpFailureReason,
} from '@agent/followUp/ToolUseFollowUp';
import type { FollowUpConsumerLease } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { getRunRecords, persistedParentRunId } from '@agent/storage/runRecords';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import {
  aggregateId,
  AgentCategory,
  ownerPid,
  RUN_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
} from '@shared/schemas';
import { runHeldMessage } from '@shared/runs/runStatusDisplay';
import { claimStanding, heldElsewhereBy } from '@shared/session/database';
import { RunLedgerRefused } from '@shared/session/runLedger';
import { FOLLOW_UP_TYPES, foldRunRows } from '@shared/session/runRows';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { createNativeSubagentStrategy } from './nativeSubagentStrategy';

import { type RunEndResult } from './RunEndResult';
import {
  ResumeSessionUnavailableError,
  resumeToolUseFromResumeData,
  type ResumeToolUseFromResumeDataOptions,
} from './executeAgent';
import { classifyRun } from './runClassification';
import { startChildRunLoop } from './childRunLoop';
import { Runs } from './runRegistry';
import { RunLive } from './runRegistry';
import {
  retrieveSessionResumeData,
  type ResumeData,
} from './SessionResumeRetrieval';
import type { SessionHandle } from './SessionHandle';
import type { AgentRunServices } from './runRegistry';

type ResumeRunCompletion = Effect.Effect<RunEndResult['outcome'], Error>;
/** A resume settles at the run's idle turn or at run termination, after admitted input is consumed. */
export type ResumeRunResult =
  | {
      readonly started: true;
      readonly delivered: boolean;
      readonly outcome?: RunEndResult['outcome'] | typeof RUN_PHASE.WAITING;
      /** A root's lifetime past its idle acknowledgement; children have none. */
      readonly completion?: ResumeRunCompletion;
      /** A workflow resume settles with its whole run: this is that run. */
      readonly result?: RunEndResult;
    }
  | { readonly failed: FollowUpFailureReason };

export interface ResumeRunOptions extends Pick<
  ResumeToolUseFromResumeDataOptions,
  'publishWorkflowOutput' | 'beforeRunEnd' | 'onRunClaimed'
> {
  /** Session owning the resumed run's coordination state. */
  readonly session: SessionHandle;
  /** Monotone per-attempt cancellation signal: once true it stays true. */
  readonly isCancellationRequested?: () => boolean;
  /**
   * Rearrange the host only after state retrieval and ownership checks have
   * accepted this run. Failures propagate; cancellation is re-read afterwards.
   */
  readonly onResumeResolved?: () => Effect.Effect<void, Error, ProcessServices>;
}

const CHANNEL = 'ResumeRun';

const REFUSED: ResumeRunResult = { failed: 'not_resumable' };

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

/**
 * Resume a stream through the single host entry path. Recovery is claimed
 * when the program starts, before the stream-to-run index performs I/O, and
 * every exit that leaves the run without it gives it back: the resume is the
 * one party that releases what it claimed. The resume is on the session's
 * `Runs`, provided here from that one session.
 */
export const resumeRun = Effect.fn('resumeRun')(function* (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeRunResult, Error, ProcessServices> {
  const session = options.session;
  const cancelled = () => options.isCancellationRequested?.() === true;
  if (cancelled()) return REFUSED;
  const recovery = session.followUps.claimRecovery(runId, true);
  if (!recovery) return REFUSED;
  // Set once a launched run owns the recovery: it gives that back itself.
  let owned = false;
  return yield* Effect.gen(function* (): Effect.fn.Return<
    ResumeRunResult,
    Error,
    AgentRunServices
  > {
    const store = getRunRecords(session, runId);
    const [config, exists] = yield* Effect.all([
      store.readConfig(),
      store.exists(),
    ]);
    if (!config || !exists) {
      yield* endUnstartedRecovery(session, recovery);
      return REFUSED;
    }
    // A run deleted during those reads took the claim with it.
    if (cancelled() || !session.followUps.useRecovery(recovery)) return REFUSED;
    // A workflow run takes no input: no queue to keep, and its resume is its
    // whole run below.
    if (config.agentCategory !== AgentCategory.ToolUse)
      session.followUps.release(recovery, 'terminal');
    const retrieved = yield* retrieveSessionResumeData(runId, config, session);
    if (cancelled()) return REFUSED;
    if (!retrieved) {
      // Given back before the classification reads the claim it took.
      session.followUps.release(recovery, 'recoverable');
      const classification = yield* classifyRun(runId, session);
      return {
        failed: yield* recordRunRefusal(runId, session, classification),
      };
    }
    const resume = retrieved;
    const claim = options.onResumeResolved
      ? yield* session.claimOwner(runId)
      : undefined;
    yield* session.clearUnreadable(runId);
    // A claim whose owner is this process, or provably dead, is one the resume
    // takes over; anything else is another live TeXRA process's run.
    const standing = claim && claimStanding(claim);
    if (standing?.kind === 'held') {
      yield* session.markUnreadable(
        runId,
        runHeldMessage(ownerPid(standing.owner)),
      );
      return { failed: 'owned_elsewhere' };
    }
    if (options.onResumeResolved) {
      yield* options.onResumeResolved();
      if (cancelled()) return REFUSED;
    }
    if (config.agentCategory === AgentCategory.ToolUse) {
      return yield* resumeQueuedToolUse(
        session,
        resume,
        recovery,
        options,
        () => {
          owned = true;
        },
      );
    }
    if (cancelled()) return REFUSED;
    const launched = yield* Effect.result(
      session.runs.launchRun(
        runId,
        resumeToolUseFromResumeData(resume, runLaunchOptions(options)),
      ),
    );
    if (Result.isFailure(launched)) {
      const refused = yield* refusalFor(launched.failure, session, runId);
      if (refused) return refused;
      return yield* Effect.fail(launched.failure);
    }
    const result = launched.success;
    return { started: true, delivered: true, outcome: result.outcome, result };
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!owned) session.followUps.release(recovery, 'recoverable');
      }),
    ),
    Effect.provideService(Runs, session.runs),
  );
}, Effect.uninterruptible);

/** What every resumed run takes from the resume's caller. */
const runLaunchOptions = (options: ResumeRunOptions) => ({
  session: options.session,
  isCancellationRequested: options.isCancellationRequested,
  publishWorkflowOutput: options.publishWorkflowOutput,
  beforeRunEnd: options.beforeRunEnd,
  onRunClaimed: options.onRunClaimed,
});

/** The follow-ups still queued on the run, folded from its durable rows. */
const queuedFollowUps = (session: SessionHandle, runId: RunId) =>
  Effect.flatMap(
    session.readAggregate(aggregateId('run', runId), FOLLOW_UP_TYPES),
    (rows) =>
      Effect.try({
        try: () => foldRunRows(rows).followUps,
        catch: ensureError,
      }),
  );

const warnUnreadable = (runId: RunId, failure: unknown): Effect.Effect<void> =>
  Effect.logWarning(
    `Run ${runId}: its queued follow-ups could not be read; keeping it recoverable`,
  ).pipe(Effect.annotateLogs({ data: failure }), withLogChannel(CHANNEL));

/**
 * A run whose records are gone: with nothing queued its input ends; durable
 * queued input or an unreadable fold keeps it recoverable.
 */
const endUnstartedRecovery = Effect.fn('endUnstartedRecovery')(function* (
  session: SessionHandle,
  recovery: FollowUpConsumerLease,
) {
  const queued = yield* queuedFollowUps(session, recovery.runId).pipe(
    Effect.map((followUps) => followUps.length > 0),
    Effect.catch((failure) =>
      warnUnreadable(recovery.runId, failure).pipe(Effect.as(true)),
    ),
  );
  const current = session.followUps.useRecovery(recovery);
  if (!current) return;
  if (queued) session.followUps.release(current, 'recoverable');
  else session.followUps.terminalize(current.runId);
});

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
 * acknowledges this batch at its first idle turn without ending its lifetime;
 * `handOff` tells the caller the run has taken the recovery over.
 */
const resumeQueuedToolUse = Effect.fn('resumeQueuedToolUse')(function* (
  session: SessionHandle,
  resume: ResumeData,
  queueLease: FollowUpConsumerLease,
  options: ResumeRunOptions,
  handOff: () => void,
): Effect.fn.Return<ResumeRunResult, Error, AgentRunServices> {
  const runId = resume.runId;
  const followUps = session.followUps;

  // Do not revive a generation while its stop is settling: a live run registry
  // entry is a run whose fiber has not settled yet.
  if ((yield* Runs).isLive(resume.runId)) return REFUSED;

  let rootCompletion: ResumeRunCompletion | undefined;
  const admitted = new Set<string>();
  const isAdmitted = (input: { readonly followUpId: string }): boolean =>
    admitted.has(input.followUpId);
  const queuedInput = queuedFollowUps(session, runId);
  // A root holds no lease of its own: its exit releases this one by the rows.
  const releaseRecovery = (exit: Exit.Exit<RunEndResult, Error>) =>
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
      for (const input of yield* queuedInput) admitted.add(input.followUpId);
      const idle = yield* Deferred.make<void>();
      const launchOptions = runLaunchOptions(options);
      const onIdle = (): void => {
        const pending = session.events.pendingFollowUps(
          aggregateId('run', runId),
        );
        if (!pending.some(isAdmitted)) Deferred.doneUnsafe(idle, Effect.void);
      };
      const parentRunId = yield* persistedParentRunId(session, runId);
      let completion: Fiber.Fiber<RunEndResult | undefined, Error>;
      if (parentRunId === undefined) {
        // Released on the run's own fiber, before it leaves the registry, so a
        // run no longer live here holds no lease; a refused launch never ran.
        const root = yield* session.runs.launch(
          runId,
          resumeToolUseFromResumeData(resume, {
            ...launchOptions,
            onIdle,
          }).pipe(Effect.onExit(releaseRecovery)),
          Effect.onError((cause) => releaseRecovery(Exit.failCause(cause))),
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
            startedAt: yield* Clock.currentTimeMillis,
            workingDirectory: resume.agentConfig.workingDirectory ?? undefined,
            userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
            resume: { identity: resume, options: { ...launchOptions, onIdle } },
          }),
        });
      }
      // The run owns this queue until termination. Interrupting either
      // observation below cannot interrupt that transferred run lifetime.
      handOff();
      return yield* Effect.raceFirst(
        Deferred.await(idle).pipe(
          Effect.as(RUN_PHASE.WAITING),
          Effect.interruptible,
        ),
        Fiber.join(completion).pipe(Effect.interruptible),
      );
    }),
  );
  if (Result.isFailure(resumed)) {
    const refusal = yield* refusalFor(resumed.failure, session, runId);
    if (refusal) return refusal;
    return yield* Effect.fail(resumed.failure);
  }
  const settled = resumed.success;
  const waiting = settled === RUN_PHASE.WAITING;
  const undelivered = !waiting && (yield* queuedInput).some(isAdmitted);
  return {
    started: true,
    delivered: !undelivered,
    outcome: waiting ? settled : settled?.outcome,
    ...(rootCompletion && { completion: rootCompletion }),
  };
});
