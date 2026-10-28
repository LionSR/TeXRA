import { Clock, Effect, Exit, Fiber, Result, Scope, Stream } from 'effect';

/**
 * The one resume entry point. Every host continues a persisted run through
 * it, including implicit follow-up wakes, and a second resume of the same
 * run joins the one in flight (`Resumes.once`). It launches on the run
 * lane; the launched run opens its own reader. Recovered children use the
 * same continuous delivery driver as newly launched children and
 * acknowledge each resumed turn separately.
 */
import { runRejection } from '@agent/storage/resumability';
import {
  getRunRecords,
  owningCall,
  persistedParentRunId,
} from '@agent/storage/runRecords';
import { findInCauseChain } from '@common/errors/errorPredicates';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import {
  type CommitOrdinal,
  qualifyAggregateId,
  type ResumeRefusal,
  type RunId,
} from '@shared/schemas';
import { DatabaseRowEarlier, heldElsewhereBy } from '@shared/session/database';
import { RunHistoryRefused } from '@shared/session/runHistory';
import { applyRunRow, isSharedRunRow } from '@shared/session/runRows';
import type { RunRows } from '@shared/session/runRowsShape';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { createNativeSubagentStrategy } from './nativeSubagentStrategy';
import { createScriptRunStrategy } from './scriptRun';
import { resumeBlocker } from './resumeBlocker';

import { type RunEndResult } from './RunEndResult';
import {
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
/** A resume answers once the run rests with the input it was resumed for
 *  taken, or once the run ends, whether or not it took that input. */
export type ResumeRunResult =
  | {
      readonly started: true;
      readonly delivered: boolean;
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
      const commit = (yield* session.followUps.read(runId)).activation?.commit;
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
  if ((yield* session.followUps.read(runId)).inputClosed) return REFUSED;
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

/**
 * Whether `runId` rests with every follow-up of `batch` taken: its rows
 * committed after `from`, applied to `input` (its input as read at `from`),
 * take the last of them while its position is `waiting` (a turn's end that
 * takes the batch with it commits `waiting` ahead of the consumption), or
 * reach a `waiting` position after. Input queued later does not change it;
 * false if the tail ends first.
 */
const restsWith = (
  session: SessionHandle,
  runId: RunId,
  batch: ReadonlySet<string>,
  from: CommitOrdinal,
  input: RunRows,
) => {
  const run = qualifyAggregateId('run', runId);
  let rows = input;
  return session.log.tail(from).pipe(
    Stream.filter((row) => {
      if (row.aggregateId !== run || !isSharedRunRow(row)) return false;
      const verdict = applyRunRow(rows, row);
      if (verdict.kind === 'applied') rows = { ...rows, ...verdict.rows };
      return (
        rows.at === 'waiting' &&
        !rows.followUps.some((f) => batch.has(f.followUpId))
      );
    }),
    Stream.take(1),
    Stream.runCount,
    Effect.map((matched) => matched > 0),
  );
};

/** Classify the expected launch refusals; unexpected failures propagate. */
function refusalFor(
  error: unknown,
  runId: RunId,
): Effect.Effect<ResumeRunResult | undefined> {
  if (error instanceof RunLive) return Effect.succeed(REFUSED);
  // A live owner refused the claim, or took it after its owner was proved dead.
  if (heldElsewhereBy(error) !== null)
    return Effect.succeed({ failed: 'owned_elsewhere' });
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
 * input itself; the resume answers at the first rest after it took this
 * batch ({@link restsWith}), without ending the run's lifetime.
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

  const resumed = yield* Effect.result(
    Effect.gen(function* () {
      // The receipt reads the rows committed from here on.
      const from = session.log.now();
      // A model switch waits for a turn: the resume does not wait on it.
      const input = yield* session.followUps.read(runId);
      const admitted = new Set(
        input.followUps
          .filter((input) => input.control?.kind !== 'model')
          .map((input) => input.followUpId),
      );
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
          resumeToolUseFromResumeData(resume, launchOptions),
          (admitted) => admitted,
        );
      } else {
        const native = {
          ...launchOptions,
          runId,
          parentRunId,
          startedAt: yield* Clock.currentTimeMillis,
          workingDirectory: resume.agentConfig.workingDirectory ?? undefined,
          resume: { identity: resume, options: launchOptions },
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
      const rested = yield* Effect.raceFirst(
        restsWith(session, runId, admitted, from, input).pipe(
          Effect.interruptible,
        ),
        Fiber.join(launched).pipe(Effect.as(false), Effect.interruptible),
      );
      return { rested, launched, admitted };
    }),
  );
  if (Result.isFailure(resumed)) {
    const refusal = yield* refusalFor(resumed.failure, runId);
    if (refusal) return refusal;
    return yield* Effect.fail(resumed.failure);
  }
  const { rested, launched, admitted } = resumed.success;
  // A run that ended first delivered the batch if none of it is queued.
  const delivered =
    rested ||
    !(yield* session.followUps.read(runId)).followUps.some((input) =>
      admitted.has(input.followUpId),
    );
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
  return { started: true, delivered, completion };
});
