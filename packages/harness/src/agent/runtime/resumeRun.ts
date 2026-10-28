import { Clock, Effect, Exit, Fiber, Latch, Result, Scope } from 'effect';

/**
 * The one resume entry point. Every host continues a persisted run through
 * it, including implicit follow-up wakes, and a second resume of the same
 * run joins the one in flight (`Resumes.once`). It launches on the run
 * lane; the launched run opens its own reader. Recovered children use the
 * same continuous delivery driver as newly launched children and
 * acknowledge each resumed turn separately.
 */
import {
  getRunRecords,
  owningCall,
  persistedParentRunId,
} from '@agent/storage/runRecords';
import { findInCauseChain } from '@common/errors/errorPredicates';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import {
  qualifyAggregateId,
  RUN_PHASE,
  type ResumeRefusal,
  type RunId,
} from '@shared/schemas';
import { DatabaseRowEarlier, heldElsewhereBy } from '@shared/session/database';
import { RunHistoryRefused } from '@shared/session/runHistory';
import { lastActivationCommit } from '@shared/session/runFacts';
import { FOLLOW_UP_TYPES, runRowsFrom } from '@shared/session/runRows';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { createNativeSubagentStrategy } from './nativeSubagentStrategy';
import { createScriptRunStrategy } from './scriptRun';
import { resumeBlocker } from './resumeBlocker';
import { runRejection } from './runClassification';

import { type RunEndResult } from './RunEndResult';
import {
  ResumeSessionUnavailableError,
  resumeToolUseFromResumeData,
  type ResumeToolUseFromResumeDataOptions,
  type ResumeTurnIdentity,
} from './executeAgent';
import { deliverHeld } from './runLaunchGuard';
import { startChildRunLoop } from './childRunLoop';
import {
  registryOf,
  type AgentRunServices,
  Runs,
  RunLive,
} from './runRegistry';
import type { SessionHandle } from './SessionHandle';

type ResumeRunCompletion = Effect.Effect<RunEndResult, Error>;
/** A resume settles at the run's idle turn or at run termination, after admitted input is consumed. */
export type ResumeRunResult =
  | {
      readonly started: true;
      readonly delivered: boolean;
      readonly outcome?: RunEndResult['outcome'] | typeof RUN_PHASE.WAITING;
      /** The run's lifetime past its idle acknowledgement, ending with its
       *  result. */
      readonly completion: ResumeRunCompletion;
    }
  | { readonly failed: ResumeRefusal };

/** One resume job's answer ({@link resumeOwnRun}): its result, or that an
 *  open call of `ownedBy` owns the run, as its records said under its claim
 *  in the job, so it resumes with that parent. */
export type ResumeAttempt = ResumeRunResult | { readonly ownedBy: RunId };

export interface ResumeRunOptions extends Pick<
  ResumeToolUseFromResumeDataOptions,
  'onRun' | 'onAdmitted' | 'stopAfterCycle' | 'tools'
> {
  /** Session owning the resumed run's coordination state. */
  readonly session: SessionHandle;
  /** This caller joined a resume already in flight: an observer. */
  readonly onJoined?: () => void;
}

const CHANNEL = 'ResumeRun';

const REFUSED: ResumeRunResult = { failed: 'not_resumable' };

/**
 * Only a run history refusal of the saved rows names an unusable checkpoint.
 * Ownership, metadata and lease failures remain operational errors.
 */
function namesUnusableCheckpoint(error: unknown): boolean {
  const reason = findInCauseChain(error, (cause) =>
    cause instanceof RunHistoryRefused ? cause.reason : undefined,
  );
  return reason === 'inconsistent' || reason === 'unprepared-history';
}

/**
 * Resume a stream through the single host entry path. A run live here is
 * refused before anything is read; one being resumed already is joined. An
 * owned child is resumed through its parent: the parent's open call
 * reattaches it, so it never runs alone or twice.
 */
export const resumeRun = Effect.fn('resumeRun')(function* (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeRunResult, Error, ProcessServices> {
  const result = yield* resumeOwnRun(runId, options);
  if (!('ownedBy' in result)) return result;
  yield* Effect.logInfo(
    `Run ${runId} belongs to an open call of run ${result.ownedBy}: resuming that run, which reattaches it`,
  ).pipe(withLogChannel(CHANNEL));
  return yield* resumeRun(result.ownedBy, options);
});

/**
 * One resume job of `runId` itself, on the session's `Runs`: an owned child
 * answers `ownedBy`, decided in the job, for a caller that follows the
 * parent itself (the package's `Session.resume`).
 */
export const resumeOwnRun = Effect.fn('resumeOwnRun')(function* (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeAttempt, Error, ProcessServices> {
  const session = options.session;
  // The resume runs on the session's fiber: its owner's interruption stops
  // it, unless a caller joined it; a joiner's ends only its own wait.
  const { result, joined } = yield* session.followUps.resumes.once(
    runId,
    resumeHere(runId, options),
    registryOf(session.runs).fork,
    options.onJoined,
  );
  if (!joined || 'ownedBy' in result) return result;
  // A joiner of a resume already in flight hears that resume's refusal or
  // failure as its own; once that resume has the run it gets its own
  // admission, under the run's claim as the resume's own is, a failure of
  // which fails this joiner alone.
  if (!('started' in result) || !options.onAdmitted) return result;
  const hook = options.onAdmitted;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const heldBy = yield* holdClaim(session, runId);
      if (heldBy !== null) return { failed: 'owned_elsewhere' } as const;
      // Joined at the activation the resume committed: the latest.
      const id = qualifyAggregateId('run', runId);
      const commit = lastActivationCommit(yield* session.log.rows(id), runId);
      if (commit === undefined)
        return yield* Effect.die(new Error(`Run ${runId} has no activation.`));
      yield* hook(runId, commit);
      return result;
    }),
  );
});

/** Hold the run's claim for the enclosing scope: null, or the live process
 *  that refused it. */
const holdClaim = (session: SessionHandle, runId: RunId) =>
  session.log.hold(runId).pipe(
    Effect.as(null),
    Effect.catch((error) => {
      const holder = heldElsewhereBy(error);
      return holder === null ? Effect.fail(error) : Effect.succeed(holder);
    }),
  );

/** One resume of a run no generation here holds. */
const resumeHere = Effect.fn('resumeHere')(function* (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeAttempt, Error, AgentRunServices | Scope.Scope> {
  const session = options.session;
  if (session.runs.get(runId)?.live === true) return REFUSED;
  const store = getRunRecords(session, runId);
  const [config, exists] = yield* Effect.all([
    store.readConfig(),
    store.exists(),
  ]);
  if (!config || !exists) {
    // A run whose records are gone: with nothing queued its input ends.
    yield* session.followUps.closeInput(runId);
    return REFUSED;
  }
  // Deleted, or its input closed, while those reads ran.
  if ((yield* session.followUps.read(runId)).closed) return REFUSED;
  // Every resume reads the run's state under its claim and holds it until
  // the launched run holds its own, so two processes never both launch it,
  // neither launches from a state read before the other ran, and a host is
  // refused before it rearranges itself. A claim this process holds, or one
  // whose owner is provably dead, is taken over.
  const claim = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(claim, Exit.void));
  const heldBy = yield* holdClaim(session, runId).pipe(Scope.provide(claim));
  if (heldBy !== null) return { failed: 'owned_elsewhere' };
  // Whether an open call owns it, read under its claim in this resume's
  // job, so the answer and the activation below are one decision.
  const owner = yield* owningCall(session, runId);
  if (owner !== null) return { ownedBy: owner.parentRunId };
  // What its children hold for it, it reads once it runs here.
  yield* deliverHeld(session, runId);
  // Nothing to continue from, or rows this build cannot open.
  const rejected = yield* runRejection(runId, session);
  if (rejected !== null) return { failed: rejected.kind };
  // An agent or plugin this process cannot run now leaves the run
  // interrupted with the reason, never failed, for the session's follower to
  // resume once it is back; nothing is launched. Another process's run
  // is refused as such above, whatever this process lacks.
  const blocker = yield* resumeBlocker(session, config);
  yield* session.view.markResumeBlocked(
    runId,
    blocker === null ? null : { reason: blocker, retry: true },
  );
  if (blocker !== null) return { failed: 'blocked' };
  // The launched run is admitted once its `run.activate` commits.
  return yield* resumeQueuedToolUse(
    session,
    { runId, agentConfig: config },
    options,
  );
}, Effect.scoped);

/** The follow-ups still queued on the run, folded from its durable rows. */
const queuedFollowUps = (session: SessionHandle, runId: RunId) =>
  Effect.flatMap(
    session.log.rows(qualifyAggregateId('run', runId), FOLLOW_UP_TYPES),
    (rows) =>
      Effect.try({
        try: () => runRowsFrom(rows).followUps,
        catch: ensureError,
      }),
  );

/** Classify the expected launch refusals; unexpected failures propagate. */
function refusalFor(
  error: unknown,
  runId: RunId,
): Effect.Effect<ResumeRunResult | undefined> {
  if (error instanceof RunLive) return Effect.succeed(REFUSED);
  // A live owner refused the claim, or took it after its owner was proved dead.
  if (heldElsewhereBy(error) !== null)
    return Effect.succeed({ failed: 'owned_elsewhere' });
  if (error instanceof ResumeSessionUnavailableError) {
    return Effect.succeed({ failed: 'finished' });
  }
  if (error instanceof DatabaseRowEarlier)
    return Effect.succeed({ failed: 'earlier_build' });
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
 * Launch a conversation with its queued input. The launched run reads that
 * input itself and acknowledges this batch at its first idle turn without
 * ending its lifetime.
 */
const resumeQueuedToolUse = Effect.fn('resumeQueuedToolUse')(function* (
  session: SessionHandle,
  resume: ResumeTurnIdentity,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeRunResult, Error, AgentRunServices> {
  const runId = resume.runId;

  // Do not revive a generation while its stop is settling: a live run registry
  // entry is a run whose fiber has not settled yet.
  if ((yield* Runs).get(resume.runId)?.live === true) return REFUSED;

  const admitted = new Set<string>();
  const isAdmitted = (input: { readonly followUpId: string }): boolean =>
    admitted.has(input.followUpId);
  const queuedInput = queuedFollowUps(session, runId);
  const resumed = yield* Effect.result(
    Effect.gen(function* () {
      // A model switch waits for a turn: the resume does not wait on it.
      for (const input of yield* queuedInput)
        if (input.control?.kind !== 'model') admitted.add(input.followUpId);
      // The run rested: once what this resume admitted is taken, the
      // resume has delivered it.
      const rested = Latch.makeUnsafe(false);
      const onIdle = (): void => {
        Latch.openUnsafe(rested);
      };
      const idle = Effect.gen(function* () {
        for (;;) {
          yield* rested.await;
          Latch.closeUnsafe(rested);
          if (!(yield* queuedInput).some(isAdmitted)) return;
        }
      });
      // What every resumed run takes from the resume's caller.
      const launchOptions = {
        session: options.session,
        onAdmitted: options.onAdmitted,
        onRun: options.onRun,
        stopAfterCycle: options.stopAfterCycle,
        tools: options.tools,
      };
      const parentRunId = yield* persistedParentRunId(session, runId);
      let launched: Fiber.Fiber<RunEndResult | undefined, Error>;
      if (parentRunId === undefined) {
        launched = yield* registryOf(session.runs).start(
          runId,
          resumeToolUseFromResumeData(resume, { ...launchOptions, onIdle }),
          (admitted) => admitted,
        );
      } else {
        const native = {
          ...launchOptions,
          runId,
          parentRunId,
          startedAt: yield* Clock.currentTimeMillis,
          workingDirectory: resume.agentConfig.workingDirectory ?? undefined,
          resume: { identity: resume, options: { ...launchOptions, onIdle } },
        };
        const { script } = resume.agentConfig;
        ({ fiber: launched } = yield* startChildRunLoop({
          session,
          runId,
          parentRunId,
          agentName: resume.agentConfig.agent,
          strategy:
            script?.kind === 'background'
              ? createScriptRunStrategy({ ...native, title: script.title })
              : createNativeSubagentStrategy(native),
        }));
      }
      // Interrupting either observation below cannot interrupt the
      // launched run's lifetime.
      const settled = yield* Effect.raceFirst(
        idle.pipe(Effect.as(RUN_PHASE.WAITING), Effect.interruptible),
        Fiber.join(launched).pipe(Effect.interruptible),
      );
      return { settled, launched };
    }),
  );
  if (Result.isFailure(resumed)) {
    const refusal = yield* refusalFor(resumed.failure, runId);
    if (refusal) return refusal;
    return yield* Effect.fail(resumed.failure);
  }
  const { settled, launched } = resumed.success;
  const waiting = settled === RUN_PHASE.WAITING;
  const undelivered = !waiting && (yield* queuedInput).some(isAdmitted);
  // A child loop that ended with no turn (a stop, a turn that threw) has
  // its result on its `run.end`.
  const completion = Effect.gen(function* () {
    const turn = yield* Fiber.join(launched);
    if (turn !== undefined) return turn;
    const end = yield* getRunRecords(session, runId).readRunEnd();
    if (end === null)
      return yield* Effect.fail(new Error(`Run ${runId} has no run.end.`));
    const { error, ...recorded } = end;
    const message = error?.message ?? `Run ${runId} ${end.outcome}.`;
    const userRetryable = error?.userRetryable ?? false;
    return {
      ...recorded,
      runId,
      ...(error && { error: { message, userRetryable } }),
    };
  });
  return {
    started: true,
    delivered: !undelivered,
    outcome: waiting ? settled : settled?.outcome,
    completion,
  };
});
