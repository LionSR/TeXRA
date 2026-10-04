import { Deferred, Effect, Fiber, Result, type Scope } from 'effect';

/**
 * The one resume entry point. Every host continues a persisted run through
 * it, including implicit follow-up wakes, and a second resume of the same
 * run joins the one in flight (`Inbox.resumeOnce`). It launches on the run
 * lane; the launched run opens its own reader. Recovered children use the
 * same continuous delivery driver as newly launched children and
 * acknowledge each resumed turn separately.
 */
import {
  recordRunRefusal,
  type FollowUpFailureReason,
} from '@agent/followUp/ToolUseFollowUp';
import {
  getRunRecords,
  owningCall,
  persistedParentRunId,
} from '@agent/storage/runRecords';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import {
  aggregateId,
  AgentCategory,
  ownerPid,
  RUN_PHASE,
  type RunId,
} from '@shared/schemas';
import { runHeldMessage } from '@shared/runs/runStatusDisplay';
import { heldElsewhereBy } from '@shared/session/database';
import { RunHistoryRefused } from '@shared/session/runHistory';
import { FOLLOW_UP_TYPES, foldRunRows } from '@shared/session/runRows';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { createNativeSubagentStrategy } from './nativeSubagentStrategy';
import { createScriptRunStrategy } from './scriptRun';
import { resumeBlocker } from './resumeBlocker';

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
   * accepted this run. It hears the run actually resumed, which is the
   * parent when the run asked for is an owned child. Failures propagate;
   * cancellation is re-read afterwards.
   */
  readonly onResumeResolved?: (
    resumed: RunId,
  ) => Effect.Effect<void, Error, ProcessServices>;
}

const CHANNEL = 'ResumeRun';

const REFUSED: ResumeRunResult = { failed: 'not_resumable' };

/**
 * Only a run history refusal of the saved rows names an unusable checkpoint.
 * Ownership, metadata and lease failures remain operational errors.
 */
function namesUnusableCheckpoint(error: unknown): boolean {
  for (let current = error, depth = 0; depth < 8; depth++) {
    if (current instanceof RunHistoryRefused) {
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
 * Resume a stream through the single host entry path. A run live here is
 * refused before anything is read; one being resumed already is joined.
 * The resume is on the session's `Runs`, provided here from that one
 * session.
 */
export const resumeRun = Effect.fn('resumeRun')(function* (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeRunResult, Error, ProcessServices> {
  const session = options.session;
  const cancelled = () => options.isCancellationRequested?.() === true;
  if (cancelled()) return REFUSED;
  // An owned child is resumed through its parent (HQ6): the parent's open
  // call reattaches it, so it never runs alone or twice.
  const owner = yield* owningCall(session, runId);
  if (owner !== null) {
    yield* Effect.logInfo(
      `Run ${runId} belongs to the open call ${owner.callId} of run ${owner.parentRunId}: resuming that run, which reattaches it`,
    ).pipe(withLogChannel(CHANNEL));
    return yield* resumeRun(owner.parentRunId, options);
  }
  const { result, joined } = yield* session.followUps.resumeOnce(
    runId,
    resumeHere(runId, options).pipe(Effect.provideService(Runs, session.runs)),
  );
  if (!joined) return result;
  // A caller that joined a resume already in flight still gets its own
  // cancellation and its own host step, once that resume has the run.
  if (cancelled()) return REFUSED;
  if ('started' in result && options.onResumeResolved)
    yield* options.onResumeResolved(runId);
  return result;
}, Effect.uninterruptible);

/** One resume of a run no generation here holds. */
const resumeHere = Effect.fn('resumeHere')(function* (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeRunResult, Error, AgentRunServices | Scope.Scope> {
  const session = options.session;
  const cancelled = () => options.isCancellationRequested?.() === true;
  if (session.runs.isLive(runId)) return REFUSED;
  const store = getRunRecords(session, runId);
  const [config, exists] = yield* Effect.all([
    store.readConfig(),
    store.exists(),
  ]);
  if (!config || !exists) {
    // A run whose records are gone: with nothing queued its input ends.
    session.followUps.closeInput(runId);
    return REFUSED;
  }
  // Deleted, or its input closed, while those reads ran.
  if (cancelled() || session.events.inputClosed(aggregateId('run', runId)))
    return REFUSED;
  const retrieved = yield* retrieveSessionResumeData(runId, config, session);
  if (cancelled()) return REFUSED;
  if (!retrieved) {
    const classification = yield* classifyRun(runId, session);
    return {
      failed: yield* recordRunRefusal(runId, session, classification),
    };
  }
  const resume = retrieved;
  // A host about to rearrange itself holds the run's claim first, until the
  // launched run holds its own: a claim this process holds, or one whose
  // owner is provably dead, is taken over; another live TeXRA process's run
  // is refused before the host changes anything.
  const heldBy = options.onResumeResolved
    ? yield* session.borrowRunClaim(runId).pipe(
        Effect.as(null),
        Effect.catch((error) => {
          const holder = heldElsewhereBy(error);
          return holder === null ? Effect.fail(error) : Effect.succeed(holder);
        }),
      )
    : null;
  yield* session.clearUnreadable(runId);
  if (heldBy !== null) {
    yield* session.markUnreadable(runId, runHeldMessage(ownerPid(heldBy)));
    return { failed: 'owned_elsewhere' };
  }
  // An agent or plugin this process cannot run now leaves the run
  // interrupted with the reason (D5), for the session's follower to
  // resume once it is back; nothing is launched. Another process's run
  // is refused as such above, whatever this process lacks.
  const blocker = yield* resumeBlocker(session, config);
  yield* session.markResumeBlocked(
    runId,
    blocker === null ? null : { reason: blocker, retry: true },
  );
  if (blocker !== null) return { failed: 'blocked' };
  if (options.onResumeResolved) {
    yield* options.onResumeResolved(runId);
    if (cancelled()) return REFUSED;
  }
  if (config.agentCategory === AgentCategory.ToolUse) {
    return yield* resumeQueuedToolUse(session, resume, options);
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
}, Effect.scoped);

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
 * Launch a conversation with its queued input. The launched run reads that
 * input itself and acknowledges this batch at its first idle turn without
 * ending its lifetime.
 */
const resumeQueuedToolUse = Effect.fn('resumeQueuedToolUse')(function* (
  session: SessionHandle,
  resume: ResumeData,
  options: ResumeRunOptions,
): Effect.fn.Return<ResumeRunResult, Error, AgentRunServices> {
  const runId = resume.runId;

  // Do not revive a generation while its stop is settling: a live run registry
  // entry is a run whose fiber has not settled yet.
  if ((yield* Runs).isLive(resume.runId)) return REFUSED;

  let rootCompletion: ResumeRunCompletion | undefined;
  const admitted = new Set<string>();
  const isAdmitted = (input: { readonly followUpId: string }): boolean =>
    admitted.has(input.followUpId);
  const queuedInput = queuedFollowUps(session, runId);
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
        const root = yield* session.runs.launch(
          runId,
          resumeToolUseFromResumeData(resume, { ...launchOptions, onIdle }),
          (admitted) => admitted,
        );
        rootCompletion = Fiber.join(root).pipe(Effect.map((r) => r.outcome));
        completion = root;
      } else {
        const native = {
          ...launchOptions,
          runId,
          parentRunId,
          startedAt: Date.now(),
          workingDirectory: resume.agentConfig.workingDirectory ?? undefined,
          resume: { identity: resume, options: { ...launchOptions, onIdle } },
        };
        // A background script reports once, at its end: no progress.
        const script =
          resume.agentConfig.agentCategory === AgentCategory.ToolUse
            ? (resume.agentConfig.backgroundScript ?? null)
            : null;
        completion = yield* startChildRunLoop({
          session,
          runId,
          parentRunId,
          agentName: resume.agentConfig.agent,
          budgeted: true,
          ...(script === null
            ? { strategy: createNativeSubagentStrategy(native) }
            : {
                strategy: createScriptRunStrategy({
                  ...native,
                  title: script.title,
                }),
                notify: () => undefined,
              }),
        });
      }
      // Interrupting either observation below cannot interrupt the
      // launched run's lifetime.
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
