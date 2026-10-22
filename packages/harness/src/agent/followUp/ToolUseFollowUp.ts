import { Cause, Effect, Fiber } from 'effect';
/** Tool-use follow-up routing and continuation ownership. */

import { runRejection } from '@agent/runtime/runClassification';
import type { ResumeRunResult } from '@agent/runtime/resumeRun';
import { registryOf } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { presentRunFailure } from '@agent/runtime/terminalResultToast';
import { withLogChannel } from '@logger/effectLog';
import {
  type CommitOrdinal,
  qualifyAggregateId,
  type RunId,
} from '@shared/schemas';
import type { InboxItem, SendOptions } from './Inbox';

/**
 * Why a submission could not be admitted, worded for the user by
 * {@link presentFollowUpResult}.
 *
 * - `finished`: the run has no checkpoint left to continue from.
 * - `unusable_checkpoint`: a checkpoint file is there but could not be turned
 *   into resume state (malformed, a spent cursor, shared state the category
 *   no longer accepts). A history listing advertises a run from the file
 *   alone, so this is the refusal that cohort meets — never `finished`, which
 *   would claim the run ended normally.
 * - `read_failed`: the run's claim or state could not be read just now
 *   (a busy or failing store), which says nothing about the run itself.
 * - `owned_elsewhere`: another process holds the run.
 * - `not_resumable`: the run has no running loop here and the submission was
 *   refused (a terminalized queue, a disposed session, or a message that
 *   is not the user's own).
 * - `blocked`: the run's agent, or its agent's plugin, is missing, off or
 *   not trusted here (`RunView.resumeBlocked` says which).
 */
export type FollowUpFailureReason =
  | 'finished'
  | 'unusable_checkpoint'
  | 'earlier_build'
  | 'read_failed'
  | 'owned_elsewhere'
  | 'not_resumable'
  | 'not_parent'
  | 'blocked';

/**
 * Three outcomes: the input reached a running loop, it waits in the run's
 * queue for the next turn, or it was not admitted for a worded reason. A
 * delivery the admission boundary had already accepted is `sent`.
 * A queued input whose recovery resume did not reach the run is still
 * queued (`wake: 'failed'`): the input belongs to the run, and an
 * explicit Resume delivers it.
 */
export type SubmitFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued'; wake?: 'failed' }
  | { status: 'failed'; reason: FollowUpFailureReason };

/** How one input is delivered to a run. */
export interface RunInboxSendOptions {
  /**
   * Notifications never revive a persisted cursor. A child delivery is an
   * ordinary continuation: its parent counts the child as active until the
   * delivery has landed, so it always finds a live or recoverable queue.
   */
  readonly mode?: 'live_notification';
  /** Only from the run's parent, by its rows (`SendOptions.fromParent`). */
  readonly fromParent?: boolean;
}

interface SubmitFollowUpOptions extends RunInboxSendOptions {
  readonly session: SessionHandle;
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
  not_parent:
    'This run is not a child of the sender: it was detached or launched by another run.',
  blocked:
    "This task's agent, or the plugin it comes from, is missing, off or not trusted. It continues once that is fixed.",
};

export const FOLLOW_UP_WAKE_FAILED_MESSAGE =
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

const RESUME_REFUSED: ResumeRunResult = { failed: 'not_resumable' };

/**
 * The resume every automatic wake and every host's Resume takes: the one
 * resume (`resumeRun`) on the session that holds the run, started on the fork
 * the session's launches run on, so the attempt belongs to the session and
 * outlives a caller that stops waiting. It reaches that resume through the
 * session's run programs (`RunRegistryInit.programs`), because a resumed
 * run's child loop wakes its parent through here in turn.
 *
 * What the run did not take is told to the user here, once: a refusal by its
 * reason, a fault as a failure unless the session's terminal-result presenter
 * took it. A fault answers as a refusal, so the caller reads one fact:
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
        Effect.tap((result) =>
          'failed' in result && !isCancellationRequested()
            ? session.interactions.emit(
                'requestShowInstruction',
                {
                  key: 'resumeRefused',
                  message: describeFollowUpFailure(result.failed),
                  showSuppress: false,
                },
                { replayWhenAttached: true },
              )
            : Effect.void,
        ),
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
 * Wake a run whose follow-up row is already durable: true when a generation
 * here reads it, either one already live (it takes the row at its next
 * park, or its exit owes the wake: {@link wakeAfterGeneration}) or the one
 * the resume ({@link resumeOnSession}) started.
 */
export function startFollowUpWake(
  runId: RunId,
  session: SessionHandle,
): Effect.Effect<boolean> {
  return Effect.suspend(() =>
    session.runs.get(runId)?.live === true
      ? Effect.succeed(true)
      : Effect.map(
          resumeOnSession(runId, session),
          (result) => 'started' in result && result.delivered,
        ),
  );
}

/**
 * The wake a run's last liveness arm here owes as it ends. A row landing
 * while a generation (or a hold) is live is left to it: `Sent.wake` is
 * false and its sender resumes nothing. But a loop stops reading before its
 * fiber ends (the description join, the terminal rows), and a hold reads
 * nothing at all, so a row landing then has no reader. The registry calls
 * this as the arm ends, with `since`, the commit the arm began at; once
 * every job enqueued before has committed (every such row is durable), a
 * run nobody here holds, with a message queued since then on an open input,
 * is resumed. A row queued before the arm began is not owed: the arm was its
 * wake (a resume that failed leaves it to the next explicit Resume), or its
 * sender saw no live arm and woke the run itself; the one resume per run
 * (`Inbox.resumeOnce`) joins the two. Nor is a row queued before a stop's
 * halt (`cancelled`): the stop ended the generation that would have read
 * it, and it stays queued for the user's next message or Resume, as a stop
 * with no generation draining leaves it. A failure to read is logged.
 */
export const wakeAfterGeneration = (
  runId: RunId,
  session: SessionHandle,
  since: CommitOrdinal,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* session.log.settled;
    if (session.runs.get(runId)?.live === true) return;
    const input = yield* session.followUps.read(runId);
    if (input.closed) return;
    const queued = new Set(
      input.followUps.flatMap((f) =>
        f.control === undefined ? [f.followUpId] : [],
      ),
    );
    const rows = yield* session.log.rows(qualifyAggregateId('run', runId), [
      'followup.queued',
      'run.position',
    ]);
    const stop = rows.findLast(
      (row) =>
        row.type === 'run.position' &&
        row.payload.at === 'halted' &&
        row.payload.outcome === 'cancelled',
    );
    const from = Math.max(since, stop?.commit ?? since);
    const landedSince = rows.some(
      (row) =>
        row.type === 'followup.queued' &&
        row.commit > from &&
        queued.has(row.followUpId),
    );
    if (landedSince) yield* startFollowUpWake(runId, session);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Run ${runId} was not woken as its generation left; an explicit Resume delivers what is queued`,
      ).pipe(
        Effect.annotateLogs({ data: Cause.squash(cause) }),
        withLogChannel(CHANNEL),
      ),
    ),
  );

type Admission =
  SubmitFollowUpResult | { readonly resume: Effect.Effect<boolean> };

/**
 * Queue a submission on the run. `live`: a running loop holds it, and one
 * reading here makes it `sent`. `wake`: a run no generation here holds is
 * owed a resume, which the caller starts. `quiet`: queued, nothing more.
 */
function admitQueued(
  runId: RunId,
  item: InboxItem,
  mode: 'live' | 'wake' | 'quiet',
  { session: ownerSession, fromParent }: SubmitFollowUpOptions,
): Effect.Effect<Admission, Error> {
  const options: SendOptions = {
    // A user's message whose loop ended while it was admitted still wakes.
    wake: mode === 'wake' || (mode === 'live' && item.from.kind === 'user'),
    fromParent,
  };
  return Effect.map(
    ownerSession.followUps.send(runId, item, options),
    (sent) => {
      if (sent.kind === 'duplicate') return { status: 'sent' };
      if (sent.kind === 'refused') {
        // Another process holds the run, the sender is not its parent, its
        // input is closed (deleted, or torn down with nothing queued), or
        // the session is disposed.
        return { status: 'failed', reason: sent.reason ?? 'not_resumable' };
      }
      if (sent.wake) return { resume: startFollowUpWake(runId, ownerSession) };
      return { status: mode === 'live' && sent.read ? 'sent' : 'queued' };
    },
  );
}

export const submitFollowUp = Effect.fn('submitFollowUp')(function* (
  runId: RunId,
  item: InboxItem,
  options: SubmitFollowUpOptions,
): Effect.fn.Return<SubmitFollowUpResult, Error> {
  const ownerSession = options.session;
  // Routed and admitted synchronously from the registry snapshot to the
  // send: the row is durable before anything is acknowledged or woken. A
  // resumed model turn completes after admission, so it cannot block later
  // input from joining the run's queue.
  const target = registryOf(ownerSession.runs).getToolUseFollowUpTarget(runId);
  let dispatch: Admission;
  if (target.kind !== 'no_session') {
    // A running loop reads it at its next park; a notification never
    // revives a persisted run.
    const live = target.kind === 'active' ? 'live' : 'wake';
    dispatch = yield* admitQueued(
      runId,
      item,
      options.mode === 'live_notification' ? 'quiet' : live,
      options,
    );
  } else {
    yield* Effect.logWarning(
      `No active session for follow-up on run ${runId}. Status: ${target.runStatus}`,
    ).pipe(withLogChannel(CHANNEL));
    // No running loop here: the persisted facts decide. Only the user's own
    // message continues a run that stopped with a checkpoint, admitted the
    // way a waiting run's is: a run's message never restarts work the user
    // stopped. Anything else refuses with its worded reason. Only the one
    // run addressed is inspected.
    // A state that cannot be read cannot be continued.
    const rejection = yield* runRejection(runId, ownerSession).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Cannot read whether ${runId} can continue`).pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel(CHANNEL),
          Effect.as({ kind: 'read_failed' } as const),
        ),
      ),
    );
    if (rejection !== null) return { status: 'failed', reason: rejection.kind };
    if (options.mode !== undefined || item.from.kind !== 'user')
      return { status: 'failed', reason: 'not_resumable' };
    dispatch = yield* admitQueued(runId, item, 'wake', options);
  }
  if ('resume' in dispatch) {
    return (yield* dispatch.resume)
      ? { status: 'queued' }
      : { status: 'queued', wake: 'failed' };
  }
  return dispatch;
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
