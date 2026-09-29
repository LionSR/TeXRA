import { Cause, Effect, Fiber } from 'effect';
/** Tool-use follow-up routing and continuation ownership. */

import {
  classifyRun,
  type RunClassification,
} from '@agent/runtime/runClassification';
import { AgentEngine } from '@agent/runtime/AgentEngine';
import type { ResumeRunResult } from '@agent/runtime/resumeRun';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { presentRunFailure } from '@agent/runtime/terminalResultToast';
import { withLogChannel } from '@logger/effectLog';
import { ownerPid, type RunId } from '@shared/schemas';
import {
  runHeldMessage,
  runUnreadableMessage,
} from '@shared/runs/runStatusDisplay';
import type { FollowUpQueueInput } from './ToolUseFollowUpQueueManager';

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
 * - `owned_elsewhere`: another TeXRA process holds the run.
 * - `not_resumable`: the run has no running loop here and the submission was
 *   refused (a terminalized queue, a disposed session, a run this process
 *   cannot classify).
 */
export type FollowUpFailureReason =
  'finished' | 'unusable_checkpoint' | 'owned_elsewhere' | 'not_resumable';

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
  owned_elsewhere:
    'This run is live in another TeXRA window. Send the message there.',
  not_resumable:
    'This run cannot accept messages right now. Resume it, or start a new agent task.',
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
      runMissing ||= session.runView(runId) === undefined;
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
 * Wake a run whose follow-up row is already durable: true when the run took
 * the resume ({@link resumeOnSession}), whether or not the caller stays for
 * the answer.
 */
export function startFollowUpWake(
  runId: RunId,
  session: SessionHandle,
): Effect.Effect<boolean> {
  return Effect.map(
    resumeOnSession(runId, session),
    (result) => 'started' in result && result.delivered,
  );
}

type Admission =
  | SubmitFollowUpResult
  | { readonly resume: Effect.Effect<boolean> }
  | { status: 'no_session' };

/**
 * Route and admit one submission. Synchronous from the registry snapshot to
 * the admission decision: two submissions to one run cannot interleave
 * between the target lookup and the admission, which is what keeps the
 * recovery claim single-owner without a per-run lock. The row is durable
 * before anything is acknowledged or woken. A resumed model turn completes
 * after this returns, so it cannot block later input from joining its queue.
 */
function admitFollowUp(
  runId: RunId,
  item: FollowUpQueueInput,
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

    if (target.kind === 'active') {
      // A child loop remains the owner during active inner turns, so input
      // joins its ordered queue rather than creating a second turn driver.
      return Effect.map(
        ownerSession.followUps.submit(runId, item, 'live_owner'),
        (submission): Admission => {
          if (submission.kind === 'duplicate') return { status: 'sent' };
          if (submission.kind === 'delivered_live') {
            return {
              status: options.mode === 'live_notification' ? 'queued' : 'sent',
            };
          }
          if (submission.kind === 'queued') return { status: 'queued' };
          // The queue is the only way in. A refusal here means another process
          // holds the run, or the session has no entry for it (terminalized by
          // a run deletion, or terminally released) or is disposed: the run's
          // controls may still be attached during teardown, but the
          // continuation boundary that owns it is gone.
          return {
            status: 'failed',
            reason: submission.reason ?? 'not_resumable',
          };
        },
      );
    }

    return admitQueued(
      runId,
      item,
      options.mode === 'live_notification' ? 'live_owner' : 'recoverable',
      ownerSession,
    );
  });
}

/**
 * Queue a submission on a run no running loop here holds: a waiting or resuming
 * run, or one a user's message continues. A `recoverable` admission reserves
 * the run's recovery when no consumer holds it, and that reservation wakes it.
 */
function admitQueued(
  runId: RunId,
  item: FollowUpQueueInput,
  admission: 'live_owner' | 'recoverable',
  ownerSession: SessionHandle,
): Effect.Effect<Exclude<Admission, { status: 'no_session' }>, Error> {
  return Effect.map(
    ownerSession.followUps.submit(runId, item, admission),
    (submission) => {
      if (submission.kind === 'duplicate') return { status: 'sent' };
      if (submission.kind === 'refused') {
        return {
          status: 'failed',
          reason: submission.reason ?? 'not_resumable',
        };
      }
      if (submission.kind !== 'queued' || !submission.wake) {
        return { status: 'queued' };
      }
      return { resume: startFollowUpWake(runId, ownerSession) };
    },
  );
}

/**
 * The one mapping from a run classification to what the user's run shows
 * and what the refusal is called. Both refusal paths use it — a follow-up
 * with no running loop here, and a resume whose checkpoint read came back empty
 * — so the two cannot word or settle the same fact differently.
 *
 * A refusal the user can see again is recorded on the run: the two
 * classifications that mean "no loop here can execute this run" — another
 * process holds it, or this process holds a lease with no live run behind it
 * — become the run's read-only detail, so the tab keeps saying why after
 * the toast is gone. A classification that read the run's state and found it
 * free (`finished`, `resumable`) DROPS any hold an earlier refusal left, and
 * with it the phase that hold retained: a run that is readable and
 * unowned must neither stay read-only nor show the WAITING a failed resume
 * rolled back to, on facts that have since changed.
 *
 * An `unclassified` run deliberately records nothing: `classifyRun` reports it
 * for any failed read, including a transient one (EMFILE, a partial read
 * racing another process's atomic rewrite), and a hold is sticky, so a blip
 * would leave the tab permanently read-only — and dropping the hold on one
 * would report a run another process is executing as finished. The unreadable
 * display fact has its own producer in the run tuple's `authorityFailure`,
 * which every later hydration re-reads.
 *
 * Nothing is written to disk.
 */
export function recordRunRefusal(
  runId: RunId,
  session: SessionHandle,
  classification: RunClassification,
): Effect.Effect<FollowUpFailureReason> {
  switch (classification.kind) {
    case 'held_elsewhere':
      return session
        .markUnreadable(runId, runHeldMessage(ownerPid(classification.owner)))
        .pipe(Effect.as('owned_elsewhere'));
    case 'owned_here':
      // A claim this process holds for a run with no running loop here is
      // a registry/claim disagreement, not a free run: it stays read-only
      // with a diagnostic naming that disagreement.
      return session
        .markUnreadable(
          runId,
          runUnreadableMessage('run claimed by this process with no live run'),
        )
        .pipe(Effect.as('not_resumable'));
    case 'finished':
      return session.clearUnreadable(runId).pipe(Effect.as('finished'));
    case 'resumable':
      return session.clearUnreadable(runId).pipe(Effect.as('not_resumable'));
    case 'unclassified':
      return Effect.succeed('not_resumable');
  }
}

export const submitFollowUp = Effect.fn('submitFollowUp')(function* (
  runId: RunId,
  item: FollowUpQueueInput,
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
    const classification = yield* classifyRun(runId, ownerSession);
    if (
      classification.kind !== 'resumable' ||
      options.mode !== undefined ||
      item.from.kind !== 'user'
    ) {
      return {
        status: 'failed',
        reason: yield* recordRunRefusal(runId, ownerSession, classification),
      };
    }
    dispatch = yield* admitQueued(runId, item, 'recoverable', ownerSession);
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
