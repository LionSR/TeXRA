import { Cause, Deferred, Effect, Fiber } from 'effect';
/** Tool-use follow-up routing and continuation ownership. */

import { runRejection } from '@agent/runtime/runClassification';
import type { ResumeAttempt, ResumeRunResult } from '@agent/runtime/resumeRun';
import { registryOf } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { presentRunFailure } from '@agent/runtime/terminalResultToast';
import { withLogChannel } from '@logger/effectLog';
import { type ResumeRefusal, type RunId } from '@shared/schemas';
import type { InboxItem } from './Inbox';

/**
 * Why a submission could not be admitted, worded for the user by
 * {@link presentFollowUpResult}: a resume's refusal (`ResumeRefusal`; a
 * message to a run with no loop here is admitted only as a resume would be,
 * and `not_resumable` there also covers a closed input, a disposed session,
 * or a message that is not the user's own), or one of the message's alone:
 *
 * - `read_failed`: the run's claim or state could not be read just now
 *   (a busy or failing store), which says nothing about the run itself.
 * - `one_shot`: the run's live loop ends after its current turn and reads
 *   no message (headless, or an in-band child), or the run has no loop of
 *   its own and its launch takes none (a background command).
 * - `not_parent`: the sender is not the run's parent.
 */
export type FollowUpFailureReason =
  ResumeRefusal | 'read_failed' | 'one_shot' | 'not_parent';

/**
 * Three outcomes: the input reached a running loop, it waits in the run's
 * queue for the next turn, or it was not admitted for a worded reason. A
 * delivery the admission boundary had already accepted is `sent`. A resume
 * the input started that the run refused is told by the resume itself; a
 * queued input whose run could not even be read for a wake is still queued
 * (`wake: 'failed'`): the input belongs to the run, and an explicit Resume
 * delivers it.
 */
export type SubmitFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued'; wake?: 'failed' }
  | { status: 'failed'; reason: FollowUpFailureReason };

/** How one input is delivered to a run. */
export interface RunInboxSendOptions {
  /** A notification for a generation already running: read at a turn's
   *  end, never resuming the run (`readableMessages`). */
  readonly hold?: 'generation';
  /** Only from the run's parent, by its rows (`SendOptions.fromParent`). */
  readonly fromParent?: boolean;
}

interface SubmitFollowUpOptions extends Omit<RunInboxSendOptions, 'hold'> {
  readonly session: SessionHandle;
  /** `'generation'` as {@link RunInboxSendOptions}; `'turn'`: a user's
   *  message the run reads when its current turn ends, not at the turn's
   *  next model request. */
  readonly hold?: 'generation' | 'turn';
}

const FAILURE_MESSAGES: Record<FollowUpFailureReason, string> = {
  finished: 'This run has finished. Start a new agent task to continue.',
  unusable_checkpoint:
    "This run's saved state could not be loaded, so it cannot be continued. Delete it from history and start a new agent task.",
  earlier_build:
    'This run was written by an earlier build, and this build cannot continue it.',
  read_failed: "This run couldn't be read right now. Try again in a moment.",
  owned_elsewhere:
    'This run is live in another process. Send the message there.',
  not_resumable:
    'This run cannot accept messages right now. Resume it, or start a new agent task.',
  one_shot:
    'This run ends after its current turn and reads no messages. Start a new agent task to continue.',
  not_parent:
    'This run is not a child of the sender: it was detached or launched by another run.',
  blocked:
    "This task's agent, or the plugin it comes from, is missing, off or not trusted. It continues once that is fixed.",
};

const FOLLOW_UP_WAKE_FAILED_MESSAGE =
  'Message queued, but the run could not be resumed automatically. Resume it to deliver the message, or start a new agent task.';

/** The one wording of each refusal, shared by every host and tool output. */
export function describeFollowUpFailure(reason: FollowUpFailureReason): string {
  return FAILURE_MESSAGES[reason];
}

export function presentFollowUpResult(
  result: SubmitFollowUpResult,
): { severity: 'none' } | { severity: 'info' | 'warning'; message: string } {
  if (result.status === 'failed') {
    return {
      severity: 'warning',
      message: describeFollowUpFailure(result.reason),
    };
  }
  if (result.status === 'queued' && result.wake === 'failed') {
    return { severity: 'info', message: FOLLOW_UP_WAKE_FAILED_MESSAGE };
  }
  return { severity: 'none' };
}

const CHANNEL = 'ToolUseFollowUp';

/** A resume's result, and whether this caller joined one in flight. */
export type Resumed = {
  readonly result: ResumeAttempt;
  readonly joined: boolean;
};

/** The resumes in flight here, by run. */
export class Resumes {
  /** The resumes in flight here, by run; only `once` changes it. */
  readonly running = new Map<
    RunId,
    { readonly done: Deferred.Deferred<ResumeAttempt, Error>; joiners: number }
  >();

  /** One resume of `runId` at a time; a joiner (`onJoined`) hears its result. */
  once<R>(
    runId: RunId,
    resume: Effect.Effect<ResumeAttempt, Error, R>,
    onJoined?: () => void,
  ): Effect.Effect<Resumed, Error, R> {
    return Effect.suspend((): Effect.Effect<Resumed, Error, R> => {
      const running = this.running.get(runId);
      if (running !== undefined) {
        running.joiners += 1;
        onJoined?.();
        return Effect.map(Deferred.await(running.done), (result) => ({
          result,
          joined: true,
        })).pipe(Effect.ensuring(Effect.sync(() => (running.joiners -= 1))));
      }
      const done = Deferred.makeUnsafe<ResumeAttempt, Error>();
      this.running.set(runId, { done, joiners: 0 });
      return resume.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            this.running.delete(runId);
            Deferred.doneUnsafe(done, exit);
          }),
        ),
        Effect.map((result) => ({ result, joined: false })),
      );
    });
  }

  /** Settles when `runId`'s resume in flight here ends; at once if none. */
  settled(runId: RunId): Effect.Effect<void> {
    const done = this.running.get(runId)?.done;
    return done
      ? Effect.asVoid(Effect.exit(Deferred.await(done)))
      : Effect.void;
  }

  /** Whether a caller is joined to `runId`'s resume in flight. */
  joined(runId: RunId): boolean {
    return (this.running.get(runId)?.joiners ?? 0) > 0;
  }
}

const RESUME_REFUSED: ResumeRunResult = { failed: 'not_resumable' };

/**
 * The resume every automatic wake takes (a message's, a child's delivery, a
 * generation's end, an interrupted task's): the one resume (`resumeRun`) on
 * the session that holds the run, started on the fork
 * the session's launches run on, so the attempt belongs to the session and
 * outlives a caller that stops waiting. It reaches that resume through the
 * session's run programs (`RunRegistryInit.programs`), because a resumed
 * run's child loop wakes its parent through here in turn.
 *
 * What the run did not take is told to the user here, once: a refusal by its
 * reason, input it started for and did not read, a fault as a failure unless
 * the session's terminal-result presenter took it. A fault answers as a refusal, so the caller reads one fact:
 * whether the run took the resume. The resume gives back the recovery it
 * claimed and the run did not take. The attempt is cancelled for good once
 * the run has left the session's view: a run id deleted and re-created is
 * not the run it was admitted for.
 */
export function resumeOnSession(
  runId: RunId,
  session: SessionHandle,
): Effect.Effect<ResumeRunResult> {
  const attempt = Effect.suspend(() => {
    let runMissing = false;
    const isCancellationRequested = (): boolean => {
      runMissing ||= session.view.run(runId) === undefined;
      return runMissing;
    };
    return session.runs
      .resume(runId, { session, isCancellationRequested })
      .pipe(
        Effect.tap((result) => {
          if (isCancellationRequested()) return Effect.void;
          // A run that started and ended without reading what it was
          // resumed for leaves that input queued.
          let message: string | null = null;
          if ('failed' in result)
            message = describeFollowUpFailure(result.failed);
          else if ('started' in result && !result.delivered)
            message = FOLLOW_UP_WAKE_FAILED_MESSAGE;
          return message === null
            ? Effect.void
            : session.interactions.emit(
                'requestShowInstruction',
                { key: 'resumeRefused', message, showSuppress: false },
                { replayWhenAttached: true },
              );
        }),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause) || isCancellationRequested())
            return Effect.succeed(RESUME_REFUSED);
          const error = Cause.squash(cause);
          return Effect.logError(`Failed to resume run ${runId}`).pipe(
            Effect.annotateLogs({ data: error }),
            withLogChannel(CHANNEL),
            Effect.andThen(
              presentRunFailure(session.interactions, error, 'Resume failed: '),
            ),
            Effect.as(RESUME_REFUSED),
          );
        }),
      );
  });
  // The attempt is the session's from the fork on; the join is observation
  // only, so it stays interruptible even where the caller is masked (a
  // child's boundary settlement waits here for its parent's whole resumed
  // turn, and a stop of that child must land before the parent parks).
  return Effect.flatMap(registryOf(session.runs).fork(attempt), (fiber) =>
    Effect.interruptible(Fiber.join(fiber)),
  );
}

/**
 * Resume a run whose follow-up row is already durable, for `Inbox.wake`: a
 * generation already live here reads the row at its next request or park,
 * and its exit owes the wake; otherwise the resume ({@link resumeOnSession})
 * runs, and tells the user whatever the run did not take, once.
 */
export function startFollowUpWake(
  runId: RunId,
  session: SessionHandle,
): Effect.Effect<void> {
  return Effect.suspend(() =>
    session.runs.get(runId)?.live === true
      ? Effect.void
      : Effect.asVoid(resumeOnSession(runId, session)),
  );
}

/**
 * The one admission of a message to a run: every host and tool sends
 * through here, and only here is a message refused. The send is durable
 * before anything is acknowledged or woken; when no reader here takes the
 * row, this asks the inbox whether the run owes a resume (`Inbox.wake`) and
 * relays its answer.
 *
 * A generation live here decides for itself (`LiveRun.readsMessages`): a
 * one-shot loop ends after its turn and reads none. With no generation here,
 * the persisted facts decide, and only the user's own message continues a
 * run that stopped with a checkpoint: a run's message or a notification
 * never restarts work the user stopped. A state that cannot be read cannot
 * be continued.
 */
export const submitFollowUp = Effect.fn('submitFollowUp')(function* (
  runId: RunId,
  item: InboxItem,
  options: SubmitFollowUpOptions,
): Effect.fn.Return<SubmitFollowUpResult, Error> {
  const { session, hold, fromParent } = options;
  const live = session.runs.get(runId);
  if (live?.live === true) {
    if (!live.readsMessages) return { status: 'failed', reason: 'one_shot' };
  } else {
    const rejection = yield* runRejection(runId, session).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Cannot read whether ${runId} can continue`).pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel(CHANNEL),
          Effect.as({ kind: 'read_failed' } as const),
        ),
      ),
    );
    if (rejection !== null) return { status: 'failed', reason: rejection.kind };
    if (hold === 'generation' || item.from.kind !== 'user')
      return { status: 'failed', reason: 'not_resumable' };
  }
  // A user's message to a run that is stopping continues it after the stop:
  // its row lands after the run's end, which the wake reads.
  if (item.from.kind === 'user' && live?.stopReason !== undefined)
    yield* live.drained;
  const sent = yield* session.followUps.send(runId, item, { hold, fromParent });
  // Another process holds the run, the sender is not its parent, its input
  // is closed (deleted, or torn down with nothing queued), or the session
  // is disposed.
  if (sent.kind === 'refused') return { status: 'failed', reason: sent.reason };
  if (sent.kind === 'queued' && sent.read) return { status: 'sent' };
  const woken = yield* session.followUps.wake(runId);
  if (!woken) return { status: 'queued', wake: 'failed' };
  return { status: sent.kind === 'duplicate' ? 'sent' : 'queued' };
});

/**
 * One run's input, as a plugin reaches it: what it sends the run (routed,
 * admitted and woken as {@link submitFollowUp} does), and when the run
 * takes no more.
 */
export interface RunInbox {
  /** Deliver `item` to the run. */
  readonly send: (
    item: InboxItem,
    options?: RunInboxSendOptions,
  ) => Effect.Effect<SubmitFollowUpResult, Error>;
  /** Hear the run take no more input, or its session's inbox close;
   *  returns the detach. */
  readonly onClosed: (listener: () => void) => () => void;
}

/** `runId`'s input on `session`. */
export const runInbox = (session: SessionHandle, runId: RunId): RunInbox => ({
  send: (item, options) => submitFollowUp(runId, item, { ...options, session }),
  onClosed: (listener) =>
    session.followUps.onClosed((closed) => {
      if (closed.kind === 'session' || closed.runId === runId) listener();
    }),
});
