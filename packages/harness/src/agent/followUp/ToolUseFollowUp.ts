import { Cause, Effect, Fiber } from 'effect';
/** Tool-use follow-up routing and continuation ownership. */

import { runRefusal } from '@agent/runtime/runClassification';
import { AgentEngine } from '@agent/runtime/AgentEngine';
import type { ResumeRunResult } from '@agent/runtime/resumeRun';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { presentRunFailure } from '@agent/runtime/terminalResultToast';
import { withLogChannel } from '@logger/effectLog';
import type { RunId } from '@shared/schemas';
import type { InboxItem } from './Inbox';

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
 * - `owned_elsewhere`: another TeXRA process holds the run.
 * - `not_resumable`: the run has no running loop here and the submission was
 *   refused (a terminalized queue, a disposed session, or a message that
 *   is not the user's own).
 * - `blocked`: the run's agent, or its agent's plugin, is missing, off or
 *   not trusted here (`RunView.resumeBlocked` says which).
 */
export type FollowUpFailureReason =
  | 'finished'
  | 'unusable_checkpoint'
  | 'read_failed'
  | 'owned_elsewhere'
  | 'not_resumable'
  | 'blocked';

/**
 * Three outcomes: the input reached a running loop, it waits in the run's
 * queue for the next turn, or it was not admitted for a worded reason. A
 * delivery the admission boundary had already accepted (#9531) is `sent`.
 * A queued input whose recovery resume did not reach the run is still
 * queued (`wake: 'failed'`): the input belongs to the run, and an
 * explicit Resume delivers it.
 */
type SubmitFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued'; wake?: 'failed' }
  | { status: 'failed'; reason: FollowUpFailureReason };

type FollowUpPresentation =
  { severity: 'none' } | { severity: 'info' | 'warning'; message: string };

interface SubmitFollowUpOptions {
  readonly session: SessionHandle;
  /**
   * Notifications never revive a persisted cursor. A child delivery is an
   * ordinary continuation: its parent counts the child as active until the
   * delivery has landed, so it always finds a live or recoverable queue.
   */
  readonly mode?: 'live_notification';
}

const FAILURE_MESSAGES: Record<FollowUpFailureReason, string> = {
  finished: 'This run has finished. Start a new agent task to continue.',
  unusable_checkpoint:
    "This run's saved state could not be loaded, so it cannot be continued. Delete it from history and start a new agent task.",
  read_failed:
    "TeXRA couldn't read this task right now. Try again in a moment.",
  owned_elsewhere:
    'This run is live in another TeXRA window. Send the message there.',
  not_resumable:
    'This run cannot accept messages right now. Resume it, or start a new agent task.',
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
): FollowUpPresentation {
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
 * outlives a caller that stops waiting. It reaches that resume through
 * {@link AgentEngine}, because a resumed run's child loop wakes its parent
 * through here in turn.
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
    return Effect.flatMap(AgentEngine, (engine) =>
      engine.resumeRun(runId, { session, isCancellationRequested }),
    ).pipe(
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
  return Effect.flatMap(session.runs.fork(attempt), Fiber.join);
}

/**
 * Wake a run whose follow-up row is already durable: true when a generation
 * here reads it, either one already live (the wake was owed when the row
 * landed, and another has started since) or the one the resume
 * ({@link resumeOnSession}) started.
 */
export function startFollowUpWake(
  runId: RunId,
  session: SessionHandle,
): Effect.Effect<boolean> {
  return Effect.suspend(() =>
    session.runs.isLive(runId)
      ? Effect.succeed(true)
      : Effect.map(
          resumeOnSession(runId, session),
          (result) => 'started' in result && result.delivered,
        ),
  );
}

type Admission =
  | SubmitFollowUpResult
  | { readonly resume: Effect.Effect<boolean> }
  | { status: 'no_session' };

/**
 * Route and admit one submission. Synchronous from the registry snapshot to
 * the send: the row is durable before anything is acknowledged or woken. A
 * resumed model turn completes after this returns, so it cannot block later
 * input from joining the run's queue.
 */
function admitFollowUp(
  runId: RunId,
  item: InboxItem,
  options: SubmitFollowUpOptions,
  ownerSession: SessionHandle,
): Effect.Effect<Admission, Error> {
  return Effect.suspend(() => {
    const target = ownerSession.runs.getToolUseFollowUpTarget(runId);

    if (target.kind === 'no_session') {
      return Effect.logWarning(
        `No active session for follow-up on run ${runId}. Status: ${target.runStatus}`,
      ).pipe(
        withLogChannel(CHANNEL),
        Effect.as<Admission>({ status: 'no_session' }),
      );
    }
    // A running loop reads it at its next park; a notification never
    // revives a persisted run.
    if (options.mode === 'live_notification')
      return admitQueued(runId, item, 'quiet', ownerSession);
    return admitQueued(
      runId,
      item,
      target.kind === 'active' ? 'live' : 'wake',
      ownerSession,
    );
  });
}

/**
 * Queue a submission on the run. `live`: a running loop holds it, and one
 * reading here makes it `sent`. `wake`: a run no generation here holds is
 * owed a resume, which the caller starts. `quiet`: queued, nothing more.
 */
function admitQueued(
  runId: RunId,
  item: InboxItem,
  mode: 'live' | 'wake' | 'quiet',
  ownerSession: SessionHandle,
): Effect.Effect<Exclude<Admission, { status: 'no_session' }>, Error> {
  return Effect.map(
    ownerSession.followUps.send(runId, item, {
      // A user's message whose loop ended while it was admitted still wakes.
      wake: mode === 'wake' || (mode === 'live' && item.from.kind === 'user'),
    }),
    (sent) => {
      if (sent.kind === 'duplicate') return { status: 'sent' };
      if (sent.kind === 'refused') {
        // Another process holds the run, or its input is closed (deleted,
        // or torn down with nothing queued), or the session is disposed.
        return { status: 'failed', reason: sent.reason ?? 'not_resumable' };
      }
      if (sent.wake) return { resume: startFollowUpWake(runId, ownerSession) };
      return { status: mode === 'live' && sent.read ? 'sent' : 'queued' };
    },
  );
}

/** How a run's refusal reads to whoever sent the input. */
const REFUSAL_REASON = {
  held_elsewhere: 'owned_elsewhere',
  finished: 'finished',
  unreadable: 'read_failed',
} as const satisfies Record<string, FollowUpFailureReason>;

export const submitFollowUp = Effect.fn('submitFollowUp')(function* (
  runId: RunId,
  item: InboxItem,
  options: SubmitFollowUpOptions,
): Effect.fn.Return<SubmitFollowUpResult, Error> {
  const ownerSession = options.session;
  const routed = yield* admitFollowUp(runId, item, options, ownerSession);
  let dispatch: Exclude<Admission, { status: 'no_session' }>;
  if ('status' in routed && routed.status === 'no_session') {
    // No running loop here: the persisted facts decide. Only the user's own
    // message continues a run that stopped with a checkpoint, admitted the
    // way a waiting run's is: a run's message never restarts work the user
    // stopped. Anything else refuses with its worded reason. Only the one
    // run addressed is inspected.
    // A state that cannot be read cannot be continued.
    const refusal = yield* runRefusal(runId, ownerSession).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Cannot read whether ${runId} can continue`).pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel(CHANNEL),
          Effect.as({ kind: 'unreadable' } as const),
        ),
      ),
    );
    if (refusal !== null)
      return { status: 'failed', reason: REFUSAL_REASON[refusal.kind] };
    if (options.mode !== undefined || item.from.kind !== 'user')
      return { status: 'failed', reason: 'not_resumable' };
    dispatch = yield* admitQueued(runId, item, 'wake', ownerSession);
  } else {
    dispatch = routed;
  }
  if ('resume' in dispatch) {
    return (yield* dispatch.resume)
      ? { status: 'queued' }
      : { status: 'queued', wake: 'failed' };
  }
  return dispatch;
});
