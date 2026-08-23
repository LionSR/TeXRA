/** Tool-use follow-up routing and continuation ownership. */
import { z } from 'zod';

import { deriveResumability } from '@agent/storage/resumability';
import { classifyRun } from '@agent/runtime/runClassification';
import {
  currentSession,
  defaultSession,
  resolveEmitSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import type { AgentResumePort } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';
import type { FollowUpQueueInput } from './FollowUpQueue';
import type { FollowUpRecoveryLease } from './ToolUseFollowUpQueueManager';

/**
 * Why a submission could not be admitted, worded for the user by
 * {@link presentFollowUpResult}.
 *
 * - `finished`: the run has no checkpoint left to continue from.
 * - `owned_elsewhere`: another TeXRA process holds the run.
 * - `not_resumable`: the stream has no live flow here and the submission was
 *   refused (a replaced continuation generation, a disposed session, a run
 *   this process cannot classify).
 * - `resume_failed`: the input was queued, but the recovery resume it
 *   triggered did not reach the run; an explicit Resume delivers it.
 */
export type FollowUpFailureReason =
  'finished' | 'owned_elsewhere' | 'not_resumable' | 'resume_failed';

/**
 * Three outcomes: the input reached a live flow, it waits in the stream's
 * queue for the next turn, or it was not admitted for a worded reason. A
 * delivery the admission boundary had already accepted (#9531) is `sent`.
 */
export type SubmitFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued' }
  | { status: 'failed'; reason: FollowUpFailureReason };

export type FollowUpPresentation =
  { severity: 'none' } | { severity: 'info' | 'warning'; message: string };

export interface SubmitFollowUpOptions {
  readonly session?: SessionHandle;
  readonly resumePort?: Pick<AgentResumePort, 'tryResumeStream'>;
  /**
   * Notifications never revive a persisted cursor. A child delivery is an
   * ordinary continuation: its parent counts the child as active until the
   * delivery has landed, so it always finds a live or recoverable queue.
   */
  readonly mode?: 'continuation' | 'live_notification' | 'child_delivery';
  /** Reject a detached producer if its originating continuation was replaced. */
  readonly expectedGenerationId?: string;
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
  resume_failed:
    'Message queued, but the run could not be resumed automatically. Resume it to deliver the message, or start a new agent task.',
};

/** The one wording of each refusal, shared by every host and tool output. */
export function describeFollowUpFailure(reason: FollowUpFailureReason): string {
  return FAILURE_MESSAGES[reason];
}

export function presentFollowUpResult(
  result: SubmitFollowUpResult,
): FollowUpPresentation {
  if (result.status !== 'failed') return { severity: 'none' };
  return {
    severity: result.reason === 'resume_failed' ? 'info' : 'warning',
    message: describeFollowUpFailure(result.reason),
  };
}

const logger = createLog('ToolUseFollowUp');
const PersistedContinuationGenerationSchema = z.looseObject({
  continuationGenerationId: z.uuid(),
});

async function restorePersistedGeneration(
  streamId: StreamTabId,
  session: SessionHandle,
): Promise<boolean> {
  // Prefer the resident snapshot record for a live session: `run.start`
  // updates it synchronously while the sidecar FK write is still queued.
  let executionId = session.snapshots.getRunMetadata(streamId, {
    quiet: true,
  }).executionId;
  if (!executionId) {
    try {
      executionId =
        (await session.snapshots.readPersistedExecutionId(streamId)) ??
        session.transcripts.getSummaryMeta(streamId)?.executionId;
    } catch (error) {
      logger.warn(
        `Cannot restore continuation generation for ${streamId}: persisted execution identity is unreadable.`,
        {
          data: {
            streamId,
            cause: 'execution_id_read_failed',
            error,
          },
        },
      );
      return false;
    }
  }
  if (!executionId) {
    logger.warn(
      `Cannot restore continuation generation for ${streamId}: no persisted execution id.`,
      {
        data: { streamId, cause: 'missing_execution_id' },
      },
    );
    return false;
  }
  const resumability = await deriveResumability(executionId);
  if (!resumability.resumable) {
    logger.warn(
      `Cannot restore continuation generation for ${streamId}: ${resumability.cause}.`,
      {
        data: { streamId, executionId, cause: resumability.cause },
      },
    );
    return false;
  }
  const parsed = PersistedContinuationGenerationSchema.safeParse(
    resumability.flowRecord.shared,
  );
  if (!parsed.success) {
    logger.warn(
      `Cannot restore continuation generation for ${streamId}: persisted flow state is invalid.`,
      {
        data: {
          streamId,
          executionId,
          cause: 'invalid_generation',
          error: parsed.error,
        },
      },
    );
    return false;
  }
  const restored = session.followUps.restorePersistedGeneration(
    streamId,
    parsed.data.continuationGenerationId,
  );
  if (restored === 'disposed') {
    logger.warn(
      `Cannot restore continuation generation for ${streamId}: follow-up queue was disposed.`,
      {
        data: { streamId, executionId, cause: 'disposed' },
      },
    );
    return false;
  }
  if (restored === 'unavailable') {
    logger.warn(
      `Cannot restore continuation generation for ${streamId}: the retained queue belongs to another generation.`,
      {
        data: { streamId, executionId, cause: 'generation_mismatch' },
      },
    );
    return false;
  }
  return true;
}

export function notifyFollowUpSent(
  streamId: StreamTabId,
  session?: SessionHandle,
): void {
  (resolveEmitSession(session) ?? defaultSession()).events.emit({
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
 * single-owner without a per-stream lock. Only the generation restore above
 * reads disk, and it runs before the snapshot is taken. A resumed model turn
 * completes after this returns, so it cannot block later input from joining
 * its queue.
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
      options.expectedGenerationId,
    );
    if (submission.kind === 'duplicate') return { status: 'sent' };
    if (submission.kind === 'live_flow') {
      if (options.mode === 'live_notification') return { status: 'queued' };
      notifyFollowUpSent(streamId, ownerSession);
      return { status: 'sent' };
    }
    if (submission.kind === 'live' || submission.kind === 'queued') {
      return { status: 'queued' };
    }
    if (submission.kind !== 'not_owned') {
      return { status: 'failed', reason: 'not_resumable' };
    }
    target.context.session.appendFollowUp(item);
    notifyFollowUpSent(streamId, ownerSession);
    return { status: 'sent' };
  }

  if (target.kind === 'no_session') {
    logger.warn(
      `No active session for follow-up on stream ${streamId}. Status: ${target.streamStatus}`,
    );
    return { status: 'no_session' };
  }

  const admission =
    options.mode === 'live_notification' ? 'live_owner' : 'recoverable';
  const submission = ownerSession.followUps.submit(
    streamId,
    item,
    admission,
    options.expectedGenerationId,
  );
  if (submission.kind === 'duplicate') return { status: 'sent' };
  if (submission.kind === 'unavailable' || submission.kind === 'not_owned') {
    return { status: 'failed', reason: 'not_resumable' };
  }
  if (submission.kind !== 'recovery') return { status: 'queued' };

  const recovery = submission.lease;
  const resume = (options.resumePort ?? platform().agentResume).tryResumeStream(
    streamId,
    recovery,
  );
  return { resume, recovery };
}

/**
 * Word the refusal of a stream with no live flow here from the persisted
 * facts: who holds the run, and whether a checkpoint is left. Read only on
 * the failure path; an unreadable fact is `not_resumable`.
 */
async function classifyRefusal(
  streamId: StreamTabId,
  session: SessionHandle,
): Promise<FollowUpFailureReason> {
  const executionId = session.snapshots.getRunMetadata(streamId, {
    quiet: true,
  }).executionId;
  if (!executionId) return 'not_resumable';
  const classification = await classifyRun(executionId);
  switch (classification.kind) {
    case 'held_elsewhere':
      return 'owned_elsewhere';
    case 'finished':
      return 'finished';
    case 'resumable':
    case 'owned_here':
    case 'unclassified':
      return 'not_resumable';
  }
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
  // A detached producer bound to a generation the session no longer holds in
  // memory (a persisted inquiry answered after a host restart) is checked
  // against the flow record on disk before a recovery admission; the check
  // is idempotent, so concurrent submissions restoring one record agree.
  if (
    options.expectedGenerationId !== undefined &&
    options.mode !== 'live_notification' &&
    ownerSession.followUps.currentGenerationId(streamId) !==
      options.expectedGenerationId &&
    ownerSession.executions.getToolUseFollowUpTarget(streamId).kind ===
      'queue' &&
    !(await restorePersistedGeneration(streamId, ownerSession))
  ) {
    notifyAdmitted(false);
    return { status: 'failed', reason: 'not_resumable' };
  }
  const dispatch = admitFollowUp(streamId, item, options, ownerSession);
  if ('resume' in dispatch) {
    notifyAdmitted(true);
    const resumed = await dispatch.resume;
    if (resumed) return { status: 'queued' };
    ownerSession.followUps.release(dispatch.recovery, 'recoverable');
    return { status: 'failed', reason: 'resume_failed' };
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
