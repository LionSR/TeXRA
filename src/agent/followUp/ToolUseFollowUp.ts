/** Tool-use follow-up routing and continuation ownership. */
import { createChannelTrace } from '@agent/trace';
import { type ToolUseFollowUpQueueReason } from '@agent/runtime/executionRegistry';
import {
  currentSession,
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import {
  getRunContextSession,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { platform } from '@platform/platform';
import type { AgentResumePort } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';
import type { FollowUpQueueInput } from './FollowUpQueue';

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

const logger = createChannelTrace('ToolUseFollowUp');

export function notifyFollowUpSent(
  streamId: StreamTabId,
  session?: SessionHandle,
): void {
  followUpSentSession(session).events.emit({
    scope: 'session',
    event: { type: 'followUpSent', payload: { streamId } },
  });
}

function followUpSentSession(session?: SessionHandle): SessionHandle {
  const owner = session ?? getRunContextSession(tryUseRunContext());
  return owner?.events ? owner : defaultSession();
}

/**
 * Submit visible input or an automatic notification through the stream's sole
 * continuation boundary. Routing, enqueue, live-owner detection, and persisted
 * recovery dispatch are one operation; callers never perform a separate wake.
 * The resume port is invoked before this function's first await, allowing its
 * synchronous recovery claim to serialize concurrent submissions.
 */
export async function submitFollowUp(
  streamId: StreamTabId,
  followUp: FollowUpQueueInput | string,
  options: SubmitFollowUpOptions = {},
): Promise<SubmitFollowUpResult> {
  const ownerSession = options.session ?? currentSession();
  const target = ownerSession.executions.getToolUseFollowUpTarget(streamId);
  const item = typeof followUp === 'string' ? { text: followUp } : followUp;

  if (target.kind === 'active') {
    // A child loop remains the owner during active inner turns, so input joins
    // its ordered queue rather than creating a second turn driver.
    const submission = ownerSession.followUps.submit(
      streamId,
      item,
      'live_owner',
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
  const submission = ownerSession.followUps.submit(streamId, item, admission);
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
  const resumed = await resume;
  if (!resumed) ownerSession.followUps.release(recovery, 'recoverable');
  return {
    status: 'queued',
    reason,
    continuation: resumed ? 'resumed' : 'resume_failed',
  };
}
