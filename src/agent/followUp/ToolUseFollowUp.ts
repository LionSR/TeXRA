/** Tool-use follow-up routing and continuation ownership. */
import { classifyRun } from '@agent/runtime/runClassification';
import { readExecutionStreamIndex } from '@agent/storage/executionListing';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import type { AgentResumePort } from '@platform/interfaces';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { streamHeldMessage } from '@shared/streams/streamStatusDisplay';
import type { FollowUpQueueInput } from './FollowUpQueue';
import type { FollowUpRecoveryLease } from './ToolUseFollowUpQueueManager';

/**
 * Why a submission could not be admitted, worded for the user by
 * {@link presentFollowUpResult}.
 *
 * - `finished`: the run has no checkpoint left to continue from.
 * - `owned_elsewhere`: another TeXRA process holds the run.
 * - `not_resumable`: the stream has no live flow here and the submission was
 *   refused (a terminalized queue, a disposed session, a run this process
 *   cannot classify).
 */
export type FollowUpFailureReason =
  'finished' | 'owned_elsewhere' | 'not_resumable';

/**
 * Three outcomes: the input reached a live flow, it waits in the stream's
 * queue for the next turn, or it was not admitted for a worded reason. A
 * delivery the admission boundary had already accepted (#9531) is `sent`.
 * A queued input whose recovery resume did not reach the run is still
 * queued (`wake: 'failed'`): the input belongs to the stream, and an
 * explicit Resume delivers it.
 */
export type SubmitFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued'; wake?: 'failed' }
  | { status: 'failed'; reason: FollowUpFailureReason };

type FollowUpPresentation =
  { severity: 'none' } | { severity: 'info' | 'warning'; message: string };

interface SubmitFollowUpOptions {
  readonly session?: SessionHandle;
  readonly resumePort?: Pick<AgentResumePort, 'tryResumeStream'>;
  /**
   * Notifications never revive a persisted cursor. A child delivery is an
   * ordinary continuation: its parent counts the child as active until the
   * delivery has landed, so it always finds a live or recoverable queue.
   */
  readonly mode?: 'live_notification' | 'child_delivery';
  /**
   * Fires once admission is decided, before any recovery resume runs. `true`
   * means the input now belongs to the stream (sent, queued, or already
   * admitted); `false` means the caller still owns it and may re-offer it.
   */
  readonly onAdmitted?: (admitted: boolean) => void;
}

const FAILURE_MESSAGES: Record<FollowUpFailureReason, string> = {
  finished: 'This run has finished. Start a new agent task to continue.',
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

export function notifyFollowUpSent(
  streamId: StreamTabId,
  session?: SessionHandle,
): void {
  (session ?? currentSession()).events.emit({
    scope: 'session',
    event: { type: 'followUpSent', payload: { streamId } },
  });
}

interface PendingResume {
  readonly resume: Promise<boolean>;
  readonly recovery: FollowUpRecoveryLease;
}

type Admission =
  SubmitFollowUpResult | PendingResume | { status: 'no_session' };

/**
 * Route and admit one submission. Synchronous from the registry snapshot to
 * the enqueue: two submissions to one stream cannot interleave between the
 * target lookup and the admission, which is what keeps the recovery claim
 * single-owner without a per-stream lock. A resumed model turn completes
 * after this returns, so it cannot block later input from joining its queue.
 */
function admitFollowUp(
  streamId: StreamTabId,
  item: FollowUpQueueInput,
  options: SubmitFollowUpOptions,
  ownerSession: SessionHandle,
): Admission {
  const target = ownerSession.executions.getToolUseFollowUpTarget(streamId);

  if (target.kind === 'active') {
    // A child loop remains the owner during active inner turns, so input joins
    // its ordered queue rather than creating a second turn driver.
    const submission = ownerSession.followUps.submit(
      streamId,
      item,
      'live_owner',
    );
    if (submission.kind === 'duplicate') return { status: 'sent' };
    if (submission.kind === 'delivered_live') {
      if (options.mode === 'live_notification') return { status: 'queued' };
      notifyFollowUpSent(streamId, ownerSession);
      return { status: 'sent' };
    }
    if (submission.kind === 'queued') return { status: 'queued' };
    // The queue is the only way in. A refusal here means the session has no
    // entry for this stream (terminalized by a stream deletion, or terminally
    // released) or is disposed: the flow context may still be attached during
    // teardown, but the continuation boundary that owns it is gone.
    return { status: 'failed', reason: 'not_resumable' };
  }

  if (target.kind === 'no_session') {
    logger.warn(
      `No active session for follow-up on stream ${streamId}. Status: ${target.streamStatus}`,
    );
    return { status: 'no_session' };
  }

  const admission =
    options.mode === 'live_notification' ? 'live_owner' : 'recoverable';
  const submission = ownerSession.followUps.submit(streamId, item, admission);
  if (submission.kind === 'duplicate') return { status: 'sent' };
  if (submission.kind === 'refused') {
    return { status: 'failed', reason: 'not_resumable' };
  }
  if (submission.kind !== 'queued' || !submission.lease) {
    return { status: 'queued' };
  }

  const recovery = submission.lease;
  const resume = (options.resumePort ?? platform().agentResume).tryResumeStream(
    streamId,
    recovery,
  );
  return { resume, recovery };
}

/**
 * The execution a stream currently belongs to. Prefer the resident snapshot
 * record for a live session: `run.start` updates it synchronously. A stream
 * whose run metadata is not resident (after a host restart, or evicted from
 * the snapshot store) resolves through the authored `meta.streamId` index.
 */
export async function lookupStreamExecutionId(
  streamId: StreamTabId,
  session: SessionHandle,
): Promise<ExecutionId | undefined> {
  return (
    session.snapshots.getRunMetadata(streamId, { quiet: true }).executionId ??
    (await readExecutionStreamIndex()).byStream.get(streamId)
  );
}

/**
 * Word the refusal of a stream with no live flow here from the persisted
 * facts: who holds the run, and whether a checkpoint is left. Read only on
 * the failure path; an unreadable fact is `not_resumable`.
 *
 * A refusal the user can see again is also recorded on the stream: the one
 * classification that means "this run is being executed elsewhere" becomes the
 * stream's read-only detail, so the tab keeps saying why after the toast is
 * gone. Every other classification read the run's state successfully, so it
 * DROPS any hold an earlier refusal left — a stream whose run is readable and
 * unowned must not stay read-only on a fact that has since changed.
 *
 * An `unclassified` run deliberately records nothing: `classifyRun` reports it
 * for any failed read, including a transient one (EMFILE, a partial read
 * racing another process's atomic rewrite), and a hold is sticky, so a blip
 * would leave the tab permanently read-only. The unreadable display fact has
 * its own producer in the run tuple's `authorityFailure`, which every later
 * hydration re-reads.
 *
 * Only the one run the user acted on is inspected, and nothing is written to
 * disk.
 */
async function classifyRefusal(
  streamId: StreamTabId,
  session: SessionHandle,
): Promise<FollowUpFailureReason> {
  let executionId: ExecutionId | undefined;
  try {
    executionId = await lookupStreamExecutionId(streamId, session);
  } catch (error) {
    logger.warn(
      `Cannot classify the refusal for ${streamId}: persisted execution identity is unreadable.`,
      { data: { streamId, error } },
    );
    return 'not_resumable';
  }
  if (!executionId) return 'not_resumable';
  const classification = await classifyRun(executionId);
  switch (classification.kind) {
    case 'held_elsewhere':
      holdRefusedStream(
        session,
        streamId,
        streamHeldMessage(classification.owner),
      );
      return 'owned_elsewhere';
    case 'finished':
      session.status.clearHold(streamId);
      return 'finished';
    case 'resumable':
    case 'owned_here':
      session.status.clearHold(streamId);
      return 'not_resumable';
    case 'unclassified':
      return 'not_resumable';
  }
}

/**
 * Record why this stream stays read-only. A live reservation in this process
 * supersedes the refusal that produced `detail` (the run is being opened here
 * right now), so the skipped hold is logged rather than forced.
 */
function holdRefusedStream(
  session: SessionHandle,
  streamId: StreamTabId,
  detail: string,
): void {
  if (session.status.markUnavailable(streamId, detail)) return;
  logger.debug(
    `Kept the live reservation on stream ${streamId} instead of marking it unavailable: ${detail}`,
  );
}

export async function submitFollowUp(
  streamId: StreamTabId,
  followUp: FollowUpQueueInput | string,
  options: SubmitFollowUpOptions = {},
): Promise<SubmitFollowUpResult> {
  const ownerSession = options.session ?? currentSession();
  const item = typeof followUp === 'string' ? { text: followUp } : followUp;
  // A host callback must not be able to strand the recovery lease below:
  // its failure is the host's to log, never this boundary's to propagate.
  const notifyAdmitted = (admitted: boolean): void => {
    try {
      options.onAdmitted?.(admitted);
    } catch (error) {
      logger.warn(`onAdmitted callback failed for stream ${streamId}`, {
        data: { streamId, error: String(error) },
      });
    }
  };
  const dispatch = admitFollowUp(streamId, item, options, ownerSession);
  if ('resume' in dispatch) {
    notifyAdmitted(true);
    const resumed = await dispatch.resume;
    if (resumed) return { status: 'queued' };
    ownerSession.followUps.release(dispatch.recovery, 'recoverable');
    return { status: 'queued', wake: 'failed' };
  }
  if (dispatch.status === 'no_session') {
    notifyAdmitted(false);
    return {
      status: 'failed',
      reason: await classifyRefusal(streamId, ownerSession),
    };
  }
  notifyAdmitted(dispatch.status !== 'failed');
  return dispatch;
}
