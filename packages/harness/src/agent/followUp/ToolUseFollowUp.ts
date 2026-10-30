import { Cause, Deferred, Effect, Fiber } from 'effect';
/** Tool-use follow-up routing and continuation ownership. */

import { runRejection } from '@agent/storage/resumability';
import type { ResumeAttempt, ResumeRunOptions } from '@agent/runtime/resumeRun';
import { registryOf } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { presentRunFailure } from '@agent/runtime/HostInteractions';
import { withLogChannel } from '@logger/effectLog';
import {
  type CommitOrdinal,
  type ResumeRefusal,
  type RunId,
} from '@shared/schemas';
import { withPerKeyLane } from '@utils/core/perKeyQueue';
import type { InboxItem } from './Inbox';

/**
 * Why a submission could not be admitted, worded for the user by
 * {@link presentFollowUpResult}: a resume's refusal (`ResumeRefusal`; a
 * message to a run with no loop here is admitted only as a resume would be,
 * and `not_resumable` there also covers a closed input, a disposed session,
 * or a message that does not wake the run), or one of the message's alone:
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
  | { status: 'queued'; wake?: 'failed' | null }
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
  /** The message's media, read in the run's send lane once the message is
   *  accepted, so a slow read never lets a later message commit first. */
  readonly attach?: Effect.Effect<Pick<InboxItem, 'media' | 'blobs'>, Error>;
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

/** A resume's refusal of a run that cannot continue here. */
export const REFUSED: { readonly failed: ResumeRefusal } = {
  failed: 'not_resumable',
};

/** A resume in flight here, on its run's activation. */
export interface RunAttempt {
  /** Its answer, which every caller hears. */
  readonly answer: Effect.Effect<ResumeAttempt, Error>;
  /** The commit of the `run.activate` it admitted the run at. */
  readonly admitted: Deferred.Deferred<CommitOrdinal>;
  /** The callers waiting on its answer. */
  waiters: number;
  /** A caller holds the activated run, or none holds the resume (a wake):
   *  only a stop or the session's close ends the run now. */
  handedOff: boolean;
  /** The activation it opened, which `RunRegistry.start` links: unset, a
   *  launch already held the run and refused this one. */
  activation?: object;
}

/**
 * Resume `runId` for the input it holds (a wake, an interrupted task): its
 * resume in flight here is joined, or one opened. No caller holds what it
 * answers, so it is handed off at once, follows an owning parent itself and
 * tells the user, once, what the run did not take; a generation live here
 * that no resume launched reads that input itself, and a run gone from the
 * view is not resumed. Gives back the resume's end, which never fails.
 */
export const wakeRun = (
  runId: RunId,
  session: SessionHandle,
): Effect.Effect<Effect.Effect<void>> =>
  Effect.gen(function* () {
    if (session.view.run(runId) === undefined) return Effect.void;
    const attempt = yield* openResume(runId, { session }, true);
    if (attempt === undefined) return Effect.void;
    attempt.handedOff = true;
    // Observation only: interruptible even where the caller is masked.
    return Effect.asVoid(Effect.interruptible(Effect.exit(attempt.answer)));
  });

/**
 * Join `runId`'s resume in flight here, or open one as its activation,
 * deciding on the session's fork. The registry opens one per activation
 * (`RunRegistry.start`): a caller that lost the race joins the winner.
 * Undefined while a launch that is no resume holds the run.
 */
export const openResume = (
  runId: RunId,
  options: ResumeRunOptions,
  wake: boolean,
): Effect.Effect<RunAttempt | undefined> =>
  // Uninterruptible: an attempt others can join always gets its answer.
  Effect.uninterruptible(
    Effect.gen(function* () {
      const runs = registryOf(options.session.runs);
      const found = runs.attemptOf(runId);
      if (found) return found;
      if (runs.get(runId) !== undefined) return undefined;
      const done = yield* Deferred.make<ResumeAttempt, Error>();
      const attempt: RunAttempt = {
        answer: Deferred.await(done),
        admitted: yield* Deferred.make<CommitOrdinal>(),
        waiters: 0,
        handedOff: wake,
      };
      // Built as it runs: a stop before it decides nothing (`start`).
      const decided = Effect.suspend(() =>
        runs.programs.resume(runId, options, (commit) =>
          Deferred.succeed(attempt.admitted, commit),
        ),
      );
      const fiber = yield* runs.start(
        runId,
        answered(runId, options.session, attempt, decided),
        (decision) => decision,
        null,
        attempt,
      );
      // Another resume holds the activation: this one's launch is refused
      // (`RunLive`), and it joins that one.
      if (attempt.activation === undefined) {
        yield* Effect.exit(Fiber.join(fiber));
        return yield* openResume(runId, options, wake);
      }
      fiber.addObserver((exit) => Deferred.doneUnsafe(done, exit));
      return attempt;
    }),
  );

/**
 * What a resume's answer owes once no caller holds it (a wake took it,
 * `handedOff`), whoever opened it: it follows an owning parent, and tells
 * the user what the run did not take, or a fault. A caller that holds the
 * answer acts on it itself.
 */
const answered = <R>(
  runId: RunId,
  session: SessionHandle,
  attempt: RunAttempt,
  decided: Effect.Effect<ResumeAttempt, Error, R>,
): Effect.Effect<ResumeAttempt, Error, R> => {
  // Latched: a run id deleted and re-created is not the run this wake was for.
  let missing = false;
  const gone = () => (missing ||= session.view.run(runId) === undefined);
  return decided.pipe(
    Effect.tap((result) => {
      if (!attempt.handedOff) return Effect.void;
      // The parent's open call reattaches the run it owns.
      if ('ownedBy' in result)
        return Effect.flatten(wakeRun(result.ownedBy, session));
      if (gone() || ('started' in result && result.delivered))
        return Effect.void;
      return session.interactions.emit(
        'requestShowInstruction',
        {
          key: 'resumeRefused',
          message:
            'failed' in result
              ? describeFollowUpFailure(result.failed)
              : FOLLOW_UP_WAKE_FAILED_MESSAGE,
          showSuppress: false,
        },
        { replayWhenAttached: true },
      );
    }),
    Effect.tapCause((cause) => {
      if (!attempt.handedOff || Cause.hasInterruptsOnly(cause) || gone())
        return Effect.void;
      const error = Cause.squash(cause);
      return Effect.logError(`Failed to resume run ${runId}`).pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
        Effect.andThen(
          presentRunFailure(session.interactions, error, 'Resume failed: '),
        ),
      );
    }),
  );
};

/**
 * The one admission of a message to a run: every host and tool sends
 * through here, and only here is a message refused. The send is durable
 * before anything is acknowledged or woken; when no reader here takes the
 * row, this asks the inbox whether the run owes a resume (`Inbox.wake`) and
 * relays its answer.
 *
 * A launch in flight here decides for itself (`LiveRun.readsMessages`): a
 * one-shot loop ends after its turn and reads none. With no launch here,
 * the persisted facts decide: the run's records whether it can continue
 * (a state that cannot be read cannot), and its input rows, in the send's
 * job, whether this message wakes it (`needsWake`).
 */
export const submitFollowUp = Effect.fn('submitFollowUp')(function* (
  runId: RunId,
  item: InboxItem,
  options: SubmitFollowUpOptions,
): Effect.fn.Return<SubmitFollowUpResult, Error> {
  const { session, hold, fromParent, attach } = options;
  // From the checks to the row's commit, one send to a run at a time, so a
  // run's messages commit in call order; the wake runs after, so a send that
  // resumes the run does not hold later sends for the resumed turn.
  const sent = yield* Effect.gen(function* () {
    const live = session.runs.get(runId);
    if (live !== undefined) {
      if (!live.readsMessages)
        return { status: 'failed', reason: 'one_shot' } as const;
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
      if (rejection !== null)
        return { status: 'failed', reason: rejection.kind } as const;
    }
    // A user's message to a run that is stopping continues it after the
    // stop: its row lands after the run's end, which the wake reads.
    if (item.from.kind === 'user' && live?.stopReason !== undefined)
      yield* live.drained;
    const media = attach === undefined ? {} : yield* attach;
    return yield* session.followUps.send(
      runId,
      { ...item, ...media },
      { hold, fromParent, wakesOnly: live === undefined },
    );
  }).pipe(withPerKeyLane(session.followUps.sendLanes, runId));
  if ('status' in sent) return sent;
  // Another process holds the run, the sender is not its parent, its input
  // is closed (deleted, or torn down with nothing queued), or the session
  // is disposed.
  if (sent.kind === 'refused') return { status: 'failed', reason: sent.reason };
  if (sent.kind === 'queued' && sent.read) return { status: 'sent' };
  // The sender hears the resume start, not the resumed turn end.
  if ((yield* session.followUps.wake(runId)) === false)
    return { status: 'queued', wake: 'failed' };
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
