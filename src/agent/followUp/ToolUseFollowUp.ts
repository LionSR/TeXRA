import { Effect, Fiber } from 'effect';
/** Tool-use follow-up routing and continuation ownership. */

import {
  classifyRun,
  type RunClassification,
} from '@agent/runtime/runClassification';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import { AgentResume } from '@platform/interfaces';
import { ownerPid, type RunId } from '@shared/schemas';
import {
  runHeldMessage,
  runUnreadableMessage,
} from '@shared/runs/runStatusDisplay';
import { ensureError } from '@utils/errors/errorMessage';
import type {
  FollowUpQueueInput,
  FollowUpRecoveryLease,
} from './ToolUseFollowUpQueueManager';

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
 * - `not_resumable`: the run has no live flow here and the submission was
 *   refused (a terminalized queue, a disposed session, a run this process
 *   cannot classify).
 */
export type FollowUpFailureReason =
  'finished' | 'unusable_checkpoint' | 'owned_elsewhere' | 'not_resumable';

/**
 * Three outcomes: the input reached a live flow, it waits in the run's
 * queue for the next turn, or it was not admitted for a worded reason. A
 * delivery the admission boundary had already accepted (#9531) is `sent`.
 * A queued input whose recovery resume did not reach the run is still
 * queued (`wake: 'failed'`): the input belongs to the run, and an
 * explicit Resume delivers it.
 */
export type SubmitFollowUpResult =
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
  /**
   * Fires once admission is decided, before any recovery resume runs. `true`
   * means the input now belongs to the run (sent, queued, or already
   * admitted); `false` means the caller still owns it and may re-offer it.
   */
  readonly onAdmitted?: (admitted: boolean) => void;
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

const logger = createLog('ToolUseFollowUp');

export function notifyFollowUpSent(runId: RunId, session: SessionHandle): void {
  session.followUps.notifySent(runId);
}

/**
 * Wake a recovery lease whose follow-up row is already durable. The wake
 * owns its settlement: a declined or faulted attempt releases the lease here,
 * so whoever starts it — a submitter that stays to collect the answer, or one
 * that does not — the next attempt can claim it. {@link submitFollowUp}
 * dispatches it detached for exactly that.
 */
export function startFollowUpWake(
  runId: RunId,
  recovery: FollowUpRecoveryLease,
  session: SessionHandle,
): Effect.Effect<boolean, never, AgentResume> {
  return Effect.flatMap(AgentResume, (resume) =>
    resume.tryResumeRun(runId, recovery),
  ).pipe(
    Effect.tap((resumed) =>
      Effect.sync(() => {
        if (!resumed) session.followUps.release(recovery, 'recoverable');
      }),
    ),
    // A faulted attempt is `false` to this caller: the retry decision is what
    // it asked for. This handler is what releases the lease on that path; the
    // success path releases it in the `tap` above unless the host accepted the
    // resume, in which case the resumed run owns it.
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn(`Resume attempt failed for run ${runId}`, { data: error });
        session.followUps.release(recovery, 'recoverable');
        return false;
      }),
    ),
  );
}

type Admission =
  | SubmitFollowUpResult
  | { readonly resume: Effect.Effect<boolean, never, AgentResume> }
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
): Effect.Effect<Admission, Error, AgentResume> {
  return Effect.suspend(() => {
    const target = ownerSession.runs.getToolUseFollowUpTarget(runId);

    if (target.kind === 'no_session') {
      logger.warn(
        `No active session for follow-up on run ${runId}. Status: ${target.runStatus}`,
      );
      return Effect.succeed<Admission>({ status: 'no_session' });
    }

    if (target.kind === 'active') {
      // A child loop remains the owner during active inner turns, so input
      // joins its ordered queue rather than creating a second turn driver.
      return Effect.map(
        ownerSession.followUps.submit(runId, item, 'live_owner'),
        (submission): Admission => {
          if (submission.kind === 'duplicate') return { status: 'sent' };
          if (submission.kind === 'delivered_live') {
            if (options.mode === 'live_notification') {
              return { status: 'queued' };
            }
            notifyFollowUpSent(runId, ownerSession);
            return { status: 'sent' };
          }
          if (submission.kind === 'queued') return { status: 'queued' };
          // The queue is the only way in. A refusal here means another process
          // holds the run, or the session has no entry for it (terminalized by
          // a run deletion, or terminally released) or is disposed: the flow
          // context may still be attached during teardown, but the
          // continuation boundary that owns it is gone.
          return {
            status: 'failed',
            reason: submission.reason ?? 'not_resumable',
          };
        },
      );
    }

    const admission =
      options.mode === 'live_notification' ? 'live_owner' : 'recoverable';
    return Effect.map(
      ownerSession.followUps.submit(runId, item, admission),
      (submission): Admission => {
        if (submission.kind === 'duplicate') return { status: 'sent' };
        if (submission.kind === 'refused') {
          return {
            status: 'failed',
            reason: submission.reason ?? 'not_resumable',
          };
        }
        if (submission.kind !== 'queued' || !submission.lease) {
          return { status: 'queued' };
        }
        return {
          resume: startFollowUpWake(runId, submission.lease, ownerSession),
        };
      },
    );
  });
}

/**
 * The one mapping from a run classification to what the user's run shows
 * and what the refusal is called. Both refusal paths use it — a follow-up
 * with no live flow here, and a resume whose checkpoint read came back empty
 * — so the two cannot word or settle the same fact differently.
 *
 * A refusal the user can see again is recorded on the run: the two
 * classifications that mean "no flow here can execute this run" — another
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
      // A claim this process holds for a run with no live flow context is
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

/**
 * Word the refusal of a run with no live flow here from the persisted
 * facts: who holds the run, and whether a checkpoint is left. Read only on
 * the failure path; an unreadable fact is `not_resumable`. Only the one run
 * the user acted on is inspected.
 */
const classifyRefusal = Effect.fn('classifyRefusal')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<FollowUpFailureReason, Error> {
  const classification = yield* classifyRun(runId, session);
  return yield* recordRunRefusal(runId, session, classification);
});

export const submitFollowUp = Effect.fn('submitFollowUp')(function* (
  runId: RunId,
  followUp: FollowUpQueueInput | string,
  options: SubmitFollowUpOptions,
): Effect.fn.Return<SubmitFollowUpResult, Error, AgentResume> {
  const ownerSession = options.session;
  const item = typeof followUp === 'string' ? { text: followUp } : followUp;
  // A host callback must not be able to strand the recovery lease below:
  // its failure is the host's to log, never this boundary's to propagate.
  const notifyAdmitted = (admitted: boolean) =>
    Effect.try({
      try: () => options.onAdmitted?.(admitted),
      catch: ensureError,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          logger.warn(`onAdmitted callback failed for run ${runId}`, {
            data: { runId, error: String(error) },
          });
        }),
      ),
    );
  const dispatch = yield* admitFollowUp(
    runId,
    item,
    options,
    ownerSession,
  ).pipe(Effect.tapError(() => notifyAdmitted(false)));
  if ('resume' in dispatch) {
    // Dispatch before announcing: the wake starts in the same step that
    // admitted it, the order the promise it replaces had, so an interrupt
    // between the two cannot leave the durable row behind a claimed lease
    // with no host ever asked. Detached, so the wake settles that lease on
    // its own whether or not this fiber stays to collect the answer.
    const wake = yield* Effect.forkDetach(dispatch.resume, {
      startImmediately: true,
    });
    yield* notifyAdmitted(true);
    const resumed = yield* Fiber.join(wake);
    if (resumed) return { status: 'queued' };
    return { status: 'queued', wake: 'failed' };
  }
  if (dispatch.status === 'no_session') {
    yield* notifyAdmitted(false);
    return {
      status: 'failed',
      reason: yield* classifyRefusal(runId, ownerSession),
    };
  }
  yield* notifyAdmitted(dispatch.status !== 'failed');
  return dispatch;
});
