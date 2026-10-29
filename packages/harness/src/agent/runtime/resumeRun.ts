import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Result,
  Scope,
  Stream,
} from 'effect';

/**
 * The one resume path. A host continues a persisted run through
 * {@link resumeRun}, a wake through `wakeRun`; both run the run's decision
 * ({@link decideResume}) as its activation, so a stop reaches it from the
 * call and a second resume of the run joins it. It launches on the run
 * lane; the launched run opens its own reader. Recovered children use the
 * same continuous delivery driver as newly launched children and
 * acknowledge each resumed turn separately.
 */
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { openResume, REFUSED } from '@agent/followUp/ToolUseFollowUp';
import { runRejection } from '@agent/storage/resumability';
import {
  getRunRecords,
  owningCall,
  persistedParentRunId,
} from '@agent/storage/runRecords';
import { findInCauseChain } from '@common/errors/errorPredicates';
import { withLogChannel } from '@logger/effectLog';
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
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
import { prepareAgentDefinition } from './AgentLaunchContext';
import { deliverHeld, runWithLaunchGuard } from './runLaunchGuard';
import { startChildRunLoop } from './childRunLoop';
import { registryOf, type AgentRunServices, RunLive } from './runRegistry';
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

/** A resume's answer: its result, or that an open call of `ownedBy` owns
 *  the run, as its records said under its claim, so it resumes with that
 *  parent. */
export type ResumeAttempt = ResumeRunResult | { readonly ownedBy: RunId };

export interface ResumeRunOptions extends Pick<
  ExecuteAgentOptions,
  'onRun' | 'tools'
> {
  /** Stop the run after one model/tool cycle instead of waiting for
   *  follow-up input. */
  readonly stopAfterCycle?: boolean;
  /** Session owning the resumed run's coordination state. */
  readonly session: SessionHandle;
  /** This caller's hook once the run is admitted at `commit`, its
   *  `run.activate`; `joined`: it found the resume in flight, an observer.
   *  A caller with a hook hands out its own handle and marks that itself
   *  (`handOver`); its answer alone hands nothing off. */
  readonly onAdmitted?: (
    runId: RunId,
    commit: CommitOrdinal,
    joined: boolean,
  ) => Effect.Effect<void>;
}

const CHANNEL = 'ResumeRun';

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
 * Resume `runId` as a caller of its resume, joined or opened here; a run
 * another launch holds here is refused. An owned child answers `ownedBy`,
 * for a caller that follows the parent itself. The last caller to leave
 * before any took the answer stops the resume and the run it launched.
 */
export const resumeRun = (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.Effect<ResumeAttempt, Error> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const runs = registryOf(options.session.runs);
      const opened = yield* openResume(runId, options, false);
      if (opened === undefined) return REFUSED;
      const { attempt, joined } = opened;
      attempt.waiters += 1;
      const { onAdmitted } = options;
      const answer = Effect.gen(function* () {
        const hook = yield* Effect.forkChild(
          Effect.flatMap(
            Deferred.await(attempt.admitted),
            (commit) => onAdmitted?.(runId, commit, joined) ?? Effect.void,
          ),
        );
        // A caller that leaves takes its hook with it.
        const result = yield* attempt.answer.pipe(
          Effect.onError(() => Fiber.interrupt(hook)),
        );
        // Admitted, this caller's hook runs to its end; never admitted, never.
        yield* Deferred.isDoneUnsafe(attempt.admitted)
          ? Fiber.join(hook)
          : Fiber.interrupt(hook);
        return result;
      });
      return yield* restore(answer).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            attempt.waiters -= 1;
            if (Exit.isSuccess(exit) && !onAdmitted) attempt.handedOff = true;
            else if (
              attempt.waiters === 0 &&
              !attempt.handedOff &&
              runs.attemptOf(runId) === attempt
            )
              runs.interrupt(runId);
          }),
        ),
      );
    }),
  );

/**
 * One resume's decision, run as its run's activation (`resumeRun`), of a
 * run no generation here holds: refused, owned by an open call of its
 * parent, or launched with its queued input, `activated` told the commit
 * of its `run.activate`.
 */
export const decideResume = Effect.fn('decideResume')(function* (
  runId: RunId,
  options: ResumeRunOptions,
  activated: (commit: CommitOrdinal) => Effect.Effect<unknown>,
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
  const heldBy = yield* session.log.hold(runId).pipe(
    Effect.as(null),
    Effect.catch((error) => {
      const holder = heldElsewhereBy(error);
      return holder === null ? Effect.fail(error) : Effect.succeed(holder);
    }),
  );
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
  return yield* resumeQueuedToolUse(session, runId, config, options, activated);
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
  runId: RunId,
  config: AgentConfig,
  options: ResumeRunOptions,
  activated: (commit: CommitOrdinal) => Effect.Effect<unknown>,
): Effect.fn.Return<ResumeRunResult, Error, AgentRunServices> {
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
      // What a resumed run takes from the resume's caller; it admits the run
      // as the resume's own.
      const launchOptions = {
        ...options,
        onAdmitted: (_: RunId, commit: CommitOrdinal) =>
          Effect.asVoid(activated(commit)),
      };
      // Its parent, read once under the claim: the run's edge for this
      // activation.
      const parentRunId = yield* persistedParentRunId(session, runId);
      let launched: Fiber.Fiber<RunEndResult | undefined, Error>;
      if (parentRunId === undefined) {
        const program = prepareAgentDefinition({
          config,
          session,
          suppressErrorNotification: true,
          stopAfterCycle: options.stopAfterCycle,
        }).pipe(
          Effect.flatMap((definition) =>
            executeAgent(definition, runId, launchOptions),
          ),
        );
        launched = yield* registryOf(session.runs).start(
          runId,
          runWithLaunchGuard(session, runId, program, true),
          (admitted) => admitted,
        );
      } else {
        const native = {
          session,
          runId,
          startedAt: yield* Clock.currentTimeMillis,
          workingDirectory: config.workingDirectory ?? undefined,
          // What a resumed run takes from the resume's caller; its parent was
          // read under the claim this resume holds until the loop takes it.
          resume: {
            ...launchOptions,
            config,
            parent: Effect.succeed(parentRunId),
          },
        };
        const { script } = config;
        ({ fiber: launched } = yield* startChildRunLoop({
          session,
          runId,
          parentRunId,
          agentName: config.agent,
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
