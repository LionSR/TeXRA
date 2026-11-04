import { Cause, Context, Deferred, Effect } from 'effect';
/** Tool-use follow-up routing and continuation ownership. */

import { earlierBuildRefusal, runRejection } from '@agent/storage/resumability';
import type { ResumeRunOptions } from '@agent/runtime/resumeRun';
import { registryOf, Runs } from '@agent/runtime/runRegistry';
import type { LaunchAnswer } from '@agent/runtime/runs';
import {
  Interactions,
  presentRunFailure,
} from '@agent/runtime/HostInteractions';
import { findInCauseChain } from '@common/errors/errorPredicates';
import { withLogChannel } from '@logger/effectLog';
import {
  HARNESS_INSTRUCTION_KEY,
  type ResumeRefusal,
  type RunId,
} from '@shared/schemas';
import { heldElsewhereBy } from '@shared/session/database';
import {
  RunHistoryRefused,
  SessionViewAccess,
  SessionLog,
} from '@shared/session/runHistory';
import { withPerKeyLane } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { sentBefore } from './followUpMessages';
import type { InboxItem, SessionInbox } from './Inbox';

/** The session's follow-up inbox ({@link SessionInbox}): every run's input,
 *  one reader each, which every message to a run is admitted through.
 *  Built by the session layer and disposed with the session. */
export class Inbox extends Context.Service<Inbox, SessionInbox>()(
  '@texra-ai/harness/session/Inbox',
) {}

/** What a follow-up's admission and its wake read of the session. */
export type FollowUpServices =
  Inbox | Runs | SessionLog | SessionViewAccess | Interactions;

/** The caller's {@link FollowUpServices}, for a run's inbox kept past the
 *  caller's fiber ({@link runInbox}). */
export const followUpServices = Effect.map(
  Effect.context<FollowUpServices>(),
  Context.pick(Inbox, Runs, SessionLog, SessionViewAccess, Interactions),
);

/**
 * Why a submission could not be admitted, worded for the user by
 * {@link presentFollowUpResult}: the kind of a resume's refusal
 * (`ResumeRefusal`; a message to a run with no loop here is admitted only as
 * a resume would be, and `notResumable` there also covers a closed input, a
 * disposed session, or a message that does not wake the run), or one of the
 * message's alone:
 *
 * - `readFailed`: the run's claim or state could not be read just now
 *   (a busy or failing store), which says nothing about the run itself.
 * - `oneShot`: the run's live loop ends after its current turn and reads
 *   no message (headless, or an in-band child), or the run has no loop of
 *   its own and its launch takes none (a background command).
 * - `notParent`: the sender is not the run's parent.
 */
export type FollowUpFailureReason =
  ResumeRefusal['kind'] | 'readFailed' | 'oneShot' | 'notParent';

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
  unusableCheckpoint:
    "This run's saved state could not be loaded, so it cannot be continued. Delete it from history and start a new agent task.",
  earlierBuild:
    'This run was written by an earlier build, and this build cannot continue it.',
  pluginUnavailable: 'This run needs a plugin that is not loaded here.',
  readFailed: "This run couldn't be read right now. Try again in a moment.",
  ownedElsewhere:
    'This run is live in another process. Send the message there.',
  notResumable:
    'This run cannot accept messages right now. Resume it, or start a new agent task.',
  oneShot:
    'This run ends after its current turn and reads no messages. Start a new agent task to continue.',
  notParent:
    'This run is not a child of the sender: it was detached or launched by another run.',
  blocked:
    "This task's agent, or the plugin it comes from, is missing, off or not trusted. It can continue once that is fixed.",
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
    const message = describeFollowUpFailure(result.reason);
    return { severity: 'warning', message };
  }
  if (result.status === 'queued' && result.wake === 'failed')
    return { severity: 'info', message: FOLLOW_UP_WAKE_FAILED_MESSAGE };
  return { severity: 'none' };
}

const CHANNEL = 'ToolUseFollowUp';

/**
 * Only a run history refusal of the saved rows names an unusable checkpoint:
 * rows that cannot be applied, a history the package's rules refuse, or turns
 * on a protocol the run's binding no longer speaks. Ownership, metadata and
 * lease failures remain operational errors.
 */
function namesUnusableCheckpoint(error: unknown): boolean {
  const reason = findInCauseChain(error, (cause) =>
    cause instanceof RunHistoryRefused ? cause.reason : undefined,
  );
  return (
    reason === 'inconsistent' ||
    reason === 'unprepared-history' ||
    reason === 'foreign-protocol'
  );
}

/** The refusal a resume's failure names, if it names one: a claim a live
 *  owner elsewhere holds, an earlier build's rows, or a checkpoint this
 *  build cannot continue. Any other failure stays the resume's. */
function refusalFor(
  error: unknown,
  runId: RunId,
): Effect.Effect<ResumeRefusal | undefined> {
  const owner = heldElsewhereBy(error);
  if (owner !== null) return Effect.succeed({ kind: 'ownedElsewhere', owner });
  const earlier = earlierBuildRefusal(error);
  if (earlier !== undefined) return Effect.succeed(earlier);
  if (namesUnusableCheckpoint(error)) {
    return Effect.logWarning(
      `Refusing to resume ${runId}: its saved state cannot be continued: ${toErrorMessage(error)}`,
    ).pipe(
      Effect.annotateLogs({ data: error }),
      withLogChannel(CHANNEL),
      Effect.as({ kind: 'unusableCheckpoint' } as const),
    );
  }
  return Effect.succeed(undefined);
}

/**
 * Open `runId`'s resume here, or join the launch of it in flight
 * (`RunRegistry.resume`), and give back its answer to wait on: the commit
 * of the activation it opened, or why it opened none (`LaunchAnswer`). A
 * failure of the launch that names a refusal is that refusal. Waiting is
 * interruptible, and leaving changes nothing about the run.
 */
export const openResume = Effect.fn('openResume')(function* (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.fn.Return<Effect.Effect<LaunchAnswer, Error>, never, Runs> {
  const runs = registryOf(yield* Runs);
  const answer = yield* runs.resume(runId, (answer) =>
    Effect.suspend(() => runs.programs.resume(runId, options, answer)),
  );
  return Deferred.await(answer).pipe(
    Effect.catch((error) =>
      Effect.flatMap(refusalFor(error, runId), (refusal) =>
        refusal === undefined
          ? Effect.fail(error)
          : Effect.succeed<LaunchAnswer>({ failed: refusal }),
      ),
    ),
    Effect.interruptible,
  );
});

/**
 * Resume `runId` for the input it holds (a wake, an interrupted task): its
 * resume in flight here is joined, or one opened. Nobody holds what it
 * answers, so this follows an owning parent itself and tells the user,
 * once, why the run did not continue, or that the resume failed; a run gone
 * from the view is not resumed, and one deleted meanwhile is told nothing.
 * Gives back the resume's end, which never fails.
 */
export const wakeRun = Effect.fn('wakeRun')(function* (
  runId: RunId,
): Effect.fn.Return<Effect.Effect<void>, never, FollowUpServices> {
  const view = yield* SessionViewAccess;
  const interactions = yield* Interactions;
  if (view.run(runId) === undefined) return Effect.void;
  const answer = yield* openResume(runId, {});
  // The end runs on the caller's fiber, over the session it was opened on.
  const services = yield* followUpServices;
  // Latched: a run id deleted and re-created is not the run this wake was for.
  let missing = false;
  const gone = () => (missing ||= view.run(runId) === undefined);
  return answer.pipe(
    Effect.flatMap((answered) => {
      // The parent's open call reattaches the run it owns.
      if ('ownedBy' in answered)
        return Effect.flatten(wakeRun(answered.ownedBy));
      if (!('failed' in answered) || gone()) return Effect.void;
      return interactions.emit('requestShowInstruction', {
        key: HARNESS_INSTRUCTION_KEY.RESUME_REFUSED,
        message: describeFollowUpFailure(answered.failed.kind),
        showSuppress: false,
      });
    }),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause) || gone()) return Effect.void;
      const error = Cause.squash(cause);
      return Effect.logError(`Failed to resume run ${runId}`).pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
        Effect.andThen(
          presentRunFailure(interactions, error, 'Resume failed: '),
        ),
      );
    }),
    Effect.asVoid,
    Effect.provide(services),
  );
});

/** Resume the run, or join its resume in flight here, if its input obliges
 *  one and no reader here takes it (`SessionInbox.owesResume`). False only
 *  if the input could not be read; else the resume's end, for a caller to
 *  wait on (at once if none started). */
export const wakeIfOwed = Effect.fn('wakeIfOwed')(function* (
  runId: RunId,
): Effect.fn.Return<false | Effect.Effect<void>, never, FollowUpServices> {
  const owed = yield* (yield* Inbox).owesResume(runId);
  if (owed === undefined) return false;
  return owed ? yield* wakeRun(runId) : Effect.void;
});

/**
 * The one admission of a message to a run: every host and tool sends
 * through here, and only here is a message refused. The send is durable
 * before anything is acknowledged or woken; when no reader here takes the
 * row, this asks the inbox whether the run owes a resume (`wakeIfOwed`,
 * over `SessionInbox.owesResume`) and relays its answer.
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
): Effect.fn.Return<SubmitFollowUpResult, Error, FollowUpServices> {
  const { hold, fromParent, attach } = options;
  const inbox = yield* Inbox;
  const runs = yield* Runs;
  // From the checks to the row's commit, one send to a run at a time, so a
  // run's messages commit in call order; the wake runs after, so a send that
  // resumes the run does not hold later sends for the resumed turn.
  const sent = yield* Effect.gen(function* () {
    if (yield* sentBefore(runId, item, hold, attach))
      return { status: 'sent' } as const;
    const live = runs.get(runId);
    if (live !== undefined) {
      if (!live.readsMessages)
        return { status: 'failed', reason: 'oneShot' } as const;
    } else {
      const rejection = yield* runRejection(runId).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Cannot read whether ${runId} can continue`).pipe(
            Effect.annotateLogs({ data: error }),
            withLogChannel(CHANNEL),
            Effect.as({ kind: 'readFailed' } as const),
          ),
        ),
      );
      if (rejection !== null)
        return { status: 'failed', reason: rejection.kind } as const;
    }
    // A user's message to a run that is stopping continues it after the
    // stop: its row lands after the run's end, which the wake reads.
    if (
      item.from.kind === 'user' &&
      live !== undefined &&
      runs.stopCause(runId) !== undefined
    )
      yield* live.drained;
    const media = attach === undefined ? {} : yield* attach;
    return yield* inbox.send(
      runId,
      { ...item, ...media },
      { hold, fromParent, wakesOnly: live === undefined },
    );
  }).pipe(withPerKeyLane(inbox.sendLanes, runId));
  if ('status' in sent) return sent;
  // Another process holds the run, the sender is not its parent, its input
  // is closed (deleted, or torn down with nothing queued), or the session
  // is disposed.
  if (sent.kind === 'refused') return { status: 'failed', reason: sent.reason };
  if (sent.kind === 'queued' && sent.read) return { status: 'sent' };
  // The sender hears the resume start, not the resumed turn end.
  if ((yield* wakeIfOwed(runId)) === false)
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

/** `runId`'s input on the session whose services are `session`
 *  ({@link followUpServices}). */
export const runInbox = (
  runId: RunId,
  session: Context.Context<FollowUpServices>,
): RunInbox => ({
  send: (item, options) =>
    submitFollowUp(runId, item, options ?? {}).pipe(Effect.provide(session)),
  onClosed: (listener) =>
    Context.get(session, Inbox).onClosed((closed) => {
      if (closed.kind === 'session' || closed.runId === runId) listener();
    }),
});
