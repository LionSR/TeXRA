import { Cause, Context, Effect, Exit } from 'effect';
/** Tool-use follow-up routing and continuation ownership. */

import { checkpointRefusal } from '@agent/storage/resumability';
import { resumeRun } from '@agent/runtime/resumeRun';
import { Runs } from '@agent/runtime/runRegistry';
import { Interactions } from '@agent/runtime/HostInteractions';
import { withLogChannel } from '@logger/effectLog';
import { type ResumeRefusal, type RunId } from '@shared/schemas';
import { SessionViewAccess, SessionLog } from '@shared/session/runHistory';
import { withPerKeyLane } from '@utils/core/perKeyQueue';
import { sentBefore } from './followUpMessages';
import { Inbox, type InboxItem } from './Inbox';

/** What a follow-up's admission and its wake read of the session. */
export type FollowUpServices =
  | Inbox
  | Runs
  | SessionLog
  | SessionViewAccess
  | Interactions;

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
 * - `notParent`: the sender is not the run's parent.
 */
export type FollowUpFailureReason =
  | ResumeRefusal['kind']
  | 'readFailed'
  | 'notParent';

/**
 * Three outcomes: the input reached a running loop, it waits in the run's
 * queue for its next turn (the resume the send started, or an explicit
 * one), or it was not admitted for a worded reason. A delivery the
 * admission boundary had already accepted is `sent`. A resume the input
 * started that the run refused is told by the resume itself.
 */
export type SubmitFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued' }
  | { status: 'failed'; reason: FollowUpFailureReason };

/** How one input is delivered to a run. */
export interface RunInboxSendOptions {
  /** Only from the run's parent, by its rows (`SendOptions.fromParent`). */
  readonly fromParent?: boolean;
}

interface SubmitFollowUpOptions extends RunInboxSendOptions {
  /** A user's message the run reads when its current turn ends, not at the
   *  turn's next model request. */
  readonly hold?: 'turn';
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
  notResumable:
    'This run cannot accept messages right now. Resume it, or start a new agent task.',
  notParent:
    'This run is not a child of the sender: it was detached or launched by another run.',
  blocked:
    "This task's agent, or the plugin it comes from, is missing, off or not trusted. It can continue once that is fixed.",
};

/** The one wording of each refusal, shared by every host and tool output. */
export function describeFollowUpFailure(reason: FollowUpFailureReason): string {
  return FAILURE_MESSAGES[reason];
}

export function presentFollowUpResult(
  result: SubmitFollowUpResult,
): { severity: 'none' } | { severity: 'warning'; message: string } {
  if (result.status === 'failed') {
    const message = describeFollowUpFailure(result.reason);
    return { severity: 'warning', message };
  }
  return { severity: 'none' };
}

const CHANNEL = 'ToolUseFollowUp';

/** A resume's refusal of a run that cannot continue here. */
export const REFUSED: { readonly failed: ResumeRefusal } = {
  failed: { kind: 'notResumable' },
};

/**
 * Resume `runId` for the input it holds (a wake, an interrupted task), with
 * no caller to hand the run to: a refused wake is logged, and the queued
 * row waits for the next explicit resume; an owning parent is followed; a
 * run gone from the view is not resumed. Never fails.
 */
export const wakeRun = Effect.fn('wakeRun')(function* (
  runId: RunId,
): Effect.fn.Return<void, never, Runs | SessionViewAccess> {
  if ((yield* SessionViewAccess).run(runId) === undefined) return;
  const resumed = yield* Effect.exit(resumeRun(runId, {}));
  if (Exit.isFailure(resumed)) {
    if (Cause.hasInterruptsOnly(resumed.cause)) return;
    yield* Effect.logError(`Failed to resume run ${runId}`).pipe(
      Effect.annotateLogs({ data: Cause.squash(resumed.cause) }),
      withLogChannel(CHANNEL),
    );
    return;
  }
  const answer = resumed.value;
  // The parent's open call reattaches the run it owns.
  if ('ownedBy' in answer) return yield* wakeRun(answer.ownedBy);
  // A run a launch here holds reads its input itself: nothing to say.
  if ('failed' in answer && (yield* Runs).get(runId) === undefined)
    yield* Effect.logWarning(
      `Run ${runId} was not resumed for its input: ${describeFollowUpFailure(answer.failed.kind)}`,
    ).pipe(withLogChannel(CHANNEL));
});

/** Resume the run if its input obliges one and no reader here takes it
 *  (`SessionInbox.owesResume`), on its own fiber: the sender hears the
 *  resume start, and a resume asked meanwhile joins it. False only if the
 *  input could not be read. */
export const wakeIfOwed = Effect.fn('wakeIfOwed')(function* (
  runId: RunId,
): Effect.fn.Return<boolean, never, Inbox | Runs | SessionViewAccess> {
  const owed = yield* (yield* Inbox).owesResume(runId);
  if (owed === undefined) return false;
  if (owed) yield* Effect.forkDetach(wakeRun(runId));
  return true;
});

/**
 * The one admission of a message to a run: every host and tool sends
 * through here, and only here is a message refused. The send is durable
 * before anything is acknowledged or woken; when no reader here takes the
 * row, this asks the inbox whether the run owes a resume (`wakeIfOwed`,
 * over `SessionInbox.owesResume`) and relays its answer.
 *
 * A run a launch here holds reads the row itself, at its next request or
 * turn boundary; a child that ends with it queued is resumed for it. With
 * no launch here, the persisted facts decide: the run's records whether
 * it can continue (a state that cannot be read cannot), and its input
 * rows, in the send's job, whether this message wakes it (`needsWake`).
 */
export const submitFollowUp = Effect.fn('submitFollowUp')(function* (
  runId: RunId,
  item: InboxItem,
  options: SubmitFollowUpOptions,
): Effect.fn.Return<SubmitFollowUpResult, Error, FollowUpServices> {
  const { hold, fromParent, attach } = options;
  const inbox = yield* Inbox;
  const runs = yield* Runs;
  const log = yield* SessionLog;
  const view = yield* SessionViewAccess;
  // From the checks to the row's commit, one send to a run at a time, so a
  // run's messages commit in call order; the wake runs after, so a send that
  // resumes the run does not hold later sends for the resumed turn.
  const sent = yield* Effect.gen(function* () {
    if (yield* sentBefore(runId, item, hold, attach))
      return { status: 'sent' } as const;
    // A run that takes no input (a process run, a one-shot root) reads
    // none, live or not: nothing would read the row.
    if (view.run(runId)?.followUpSupport === 'unsupported')
      return { status: 'failed', reason: 'notResumable' } as const;
    const live = runs.get(runId);
    if (live === undefined) {
      const rejection = yield* checkpointRefusal(runId).pipe(
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
    if (item.from.kind === 'user' && live !== undefined) {
      const facts = yield* log.facts(runId);
      if (facts?.stop !== null && facts?.end === null) yield* live.drained;
    }
    const media = attach === undefined ? {} : yield* attach;
    const landed = yield* inbox.send(
      runId,
      { ...item, ...media },
      { hold, fromParent },
    );
    return { status: 'landed', landed, live: live !== undefined } as const;
  }).pipe(withPerKeyLane(inbox.sendLanes, runId));
  if (sent.status !== 'landed') return sent;
  const { landed, live } = sent;
  // The sender is not its parent, its input is closed (deleted, or torn
  // down with nothing queued), or the session is disposed.
  if (landed.kind === 'refused')
    return { status: 'failed', reason: landed.reason };
  if (landed.kind === 'duplicate' || live) return { status: 'sent' };
  // The sender hears the resume start, not the resumed turn end; a wake
  // that could not read the run leaves the row for an explicit resume.
  yield* wakeIfOwed(runId);
  return { status: 'queued' };
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
