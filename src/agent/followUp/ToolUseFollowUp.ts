/** Tool-use follow-up routing and continuation ownership. */
import { z } from 'zod';

import { deriveResumability } from '@agent/storage/resumability';
import { type ToolUseFollowUpQueueReason } from '@agent/runtime/executionRegistry';
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

export type SubmitFollowUpResult =
  | { status: 'sent' }
  | {
      status: 'queued';
      reason: ToolUseFollowUpQueueReason;
      continuation: 'live' | 'recovering' | 'resumed' | 'resume_failed';
    }
  | {
      /**
       * The admission boundary already accepted this exact delivery id
       * (#9531): nothing was appended and no wake/resume was triggered.
       */
      status: 'duplicate';
    }
  | { status: 'no_session'; streamStatus: string | undefined }
  | { status: 'dropped' };

export type FollowUpPresentation =
  | { severity: 'none' }
  | {
      severity: 'info' | 'warning';
      message: string;
      refreshQueuedFollowUps: boolean;
    };

export interface SubmitFollowUpOptions {
  readonly session?: SessionHandle;
  readonly resumePort?: Pick<AgentResumePort, 'tryResumeStream'>;
  /**
   * Notifications never revive a persisted cursor. Child delivery may revive
   * only a recoverable queue retained while that child was active.
   */
  readonly mode?: 'continuation' | 'live_notification' | 'child_delivery';
  /** Reject a detached producer if its originating continuation was replaced. */
  readonly expectedGenerationId?: string;
}

export function presentFollowUpResult(
  result: SubmitFollowUpResult,
): FollowUpPresentation {
  if (result.status === 'dropped') {
    return {
      severity: 'warning',
      message:
        'Message dropped because no session was available to receive it. Start a new agent task to continue.',
      refreshQueuedFollowUps: true,
    };
  }
  if (result.status === 'queued' && result.continuation === 'resume_failed') {
    return {
      severity: 'info',
      message:
        'Message queued. Auto-resume failed; start a new agent task to continue.',
      refreshQueuedFollowUps: false,
    };
  }
  return { severity: 'none' };
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

/**
 * Submit visible input or an automatic notification through the stream's sole
 * continuation boundary. Routing, enqueue, live-owner detection, and persisted
 * recovery admission are serialized by the session-owned per-stream lock;
 * callers never perform a separate wake. A resumed model turn completes after
 * that lock is released, so it cannot block later input from joining its queue.
 */
interface PendingResume {
  readonly resume: Promise<boolean>;
  readonly recovery: FollowUpRecoveryLease;
  readonly reason: ToolUseFollowUpQueueReason;
}

async function submitFollowUpSerialized(
  streamId: StreamTabId,
  followUp: FollowUpQueueInput | string,
  options: SubmitFollowUpOptions,
  ownerSession: SessionHandle,
): Promise<SubmitFollowUpResult | PendingResume> {
  const target = ownerSession.executions.getToolUseFollowUpTarget(streamId);
  const item = typeof followUp === 'string' ? { text: followUp } : followUp;

  if (target.kind === 'active') {
    // A child loop remains the owner during active inner turns, so input joins
    // its ordered queue rather than creating a second turn driver.
    const submission = ownerSession.followUps.submit(
      streamId,
      item,
      'live_owner',
      options.expectedGenerationId,
    );
    if (submission.kind === 'duplicate') {
      return { status: 'duplicate' };
    }
    if (submission.kind === 'live_flow') {
      if (options.mode === 'live_notification') {
        return {
          status: 'queued',
          reason: 'waiting',
          continuation: 'live',
        };
      }
      notifyFollowUpSent(streamId, ownerSession);
      return { status: 'sent' };
    }
    if (submission.kind === 'live' || submission.kind === 'queued') {
      return {
        status: 'queued',
        reason: 'waiting',
        continuation: 'live',
      };
    }
    if (submission.kind !== 'not_owned') return { status: 'dropped' };
    target.context.session.appendFollowUp(item);
    notifyFollowUpSent(streamId, ownerSession);
    return { status: 'sent' };
  }

  if (target.kind === 'no_session' && options.mode !== 'child_delivery') {
    logger.warn(
      `No active session for follow-up on stream ${streamId}. Status: ${target.streamStatus}`,
    );
    return { status: 'no_session', streamStatus: target.streamStatus };
  }

  const reason = target.kind === 'queue' ? target.reason : 'children_running';
  let admission: 'live_owner' | 'recoverable' | 'existing_recoverable' =
    'recoverable';
  if (options.mode === 'live_notification') {
    admission = 'live_owner';
  } else if (target.kind === 'no_session') {
    admission = 'existing_recoverable';
  }
  if (
    admission === 'recoverable' &&
    options.expectedGenerationId !== undefined &&
    ownerSession.followUps.currentGenerationId(streamId) !==
      options.expectedGenerationId
  ) {
    const restored = await restorePersistedGeneration(streamId, ownerSession);
    if (!restored) return { status: 'dropped' };
  }
  const submission = ownerSession.followUps.submit(
    streamId,
    item,
    admission,
    options.expectedGenerationId,
  );
  if (submission.kind === 'duplicate') {
    return { status: 'duplicate' };
  }
  if (submission.kind === 'unavailable' || submission.kind === 'not_owned') {
    return { status: 'dropped' };
  }
  if (submission.kind !== 'recovery') {
    return {
      status: 'queued',
      reason,
      continuation: submission.kind === 'recovering' ? 'recovering' : 'live',
    };
  }

  const recovery = submission.lease;
  const resume = (options.resumePort ?? platform().agentResume).tryResumeStream(
    streamId,
    recovery,
  );
  return { resume, recovery, reason };
}

export async function submitFollowUp(
  streamId: StreamTabId,
  followUp: FollowUpQueueInput | string,
  options: SubmitFollowUpOptions = {},
): Promise<SubmitFollowUpResult> {
  const ownerSession = options.session ?? currentSession();
  const dispatch = await ownerSession.followUps.runSubmissionExclusive(
    streamId,
    () => submitFollowUpSerialized(streamId, followUp, options, ownerSession),
  );
  if (!('resume' in dispatch)) return dispatch;

  const resumed = await dispatch.resume;
  if (!resumed) {
    ownerSession.followUps.release(dispatch.recovery, 'recoverable');
  }
  return {
    status: 'queued',
    reason: dispatch.reason,
    continuation: resumed ? 'resumed' : 'resume_failed',
  };
}
