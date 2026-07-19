/**
 * Tool-use follow-up message coordination.
 *
 * Routes follow-up messages to the appropriate session based on state:
 * - Active session: direct append
 * - Resuming session: queue for later
 * - No session: return status (caller handles UI)
 *
 * This module is VS Code-agnostic. Callers are responsible for
 * showing appropriate UI notifications based on the returned result.
 */

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
import type { StreamTabId } from '@shared/schemas';
import type { FollowUpQueueInput } from './FollowUpQueue';

/**
 * Result of sending a follow-up message to a tool-use session.
 */
export type SendFollowUpResult =
  | { status: 'sent' }
  | {
      status: 'queued';
      reason: ToolUseFollowUpQueueReason;
    }
  | { status: 'no_session'; streamStatus: string | undefined };

export type FollowUpWakeResult =
  | { kind: 'not_required' }
  | { kind: 'queued_without_wake' }
  | { kind: 'resumed' }
  | { kind: 'resume_in_flight' }
  | { kind: 'active_or_resuming' }
  | { kind: 'queued_resume_failed' }
  | { kind: 'dropped' };

export type FollowUpWakePresentation =
  | { severity: 'none' }
  | {
      severity: 'info' | 'warning';
      message: string;
      refreshQueuedFollowUps: boolean;
    };

export interface FollowUpResumePort {
  tryResumeStream(streamId: StreamTabId): Promise<boolean>;
  isResumeInFlight?(streamId: StreamTabId): boolean;
}

/** In-flight resume attempts per stream — see {@link wakeQueuedFollowUpStream}. */
const wakeAttempts = new Map<StreamTabId, Promise<boolean>>();

/**
 * After a queued delivery, wake a stream whose cycle has exited (WAITING
 * snapshot or disposed-with-children) via the host resume port so the queued
 * item is consumed instead of sitting until the user pokes the stream. When
 * the wake fails and the stream is gone for good (`children_running` on a
 * non-in-flight stream), re-release the force-reopened queue so late
 * deliveries don't leak into the next run on that stream.
 *
 * Returns a declarative outcome so hosts can map queue/wake policy to their
 * own user-facing messages without reconstructing the release rules.
 */
export async function wakeQueuedFollowUpStream(
  streamId: StreamTabId,
  result: SendFollowUpResult,
  resumePort?: FollowUpResumePort,
  session?: SessionHandle,
): Promise<FollowUpWakeResult> {
  if (
    result.status !== 'queued' ||
    (result.reason !== 'waiting' && result.reason !== 'children_running')
  ) {
    return result.status === 'queued'
      ? { kind: 'queued_without_wake' }
      : { kind: 'not_required' };
  }
  // Serialize wakes per stream: hosts report an already-in-flight resume as
  // `false`, indistinguishable from "unresumable", and may not have set
  // RESUMING yet — so a concurrent wake must await the first attempt's
  // outcome instead of re-poking the port and releasing the queue the
  // in-flight resume is about to drain.
  let attempt = wakeAttempts.get(streamId);
  const port = resumePort ?? platform().agentResume;
  if (!attempt) {
    attempt = port.tryResumeStream(streamId).finally(() => {
      wakeAttempts.delete(streamId);
    });
    wakeAttempts.set(streamId, attempt);
  }
  const resumed = await attempt;
  if (resumed) {
    return { kind: 'resumed' };
  }
  if (port.isResumeInFlight?.(streamId) === true) {
    return { kind: 'resume_in_flight' };
  }
  const ownerSession = session ?? currentSession();
  if (ownerSession.status.isActiveOrResuming(streamId)) {
    return { kind: 'active_or_resuming' };
  }
  if (result.reason !== 'children_running') {
    return { kind: 'queued_resume_failed' };
  }
  ownerSession.followUps.release(streamId);
  return { kind: 'dropped' };
}

/**
 * Shared host-facing presentation for wake outcomes. It intentionally maps
 * only queue/wake policy to UI text; provider/model follow-up construction
 * stays with the caller that owns that context.
 */
export function presentFollowUpWakeResult(
  result: FollowUpWakeResult,
): FollowUpWakePresentation {
  switch (result.kind) {
    case 'dropped':
      return {
        severity: 'warning',
        message:
          'Message dropped because no session was available to receive it. Start a new agent task to continue.',
        refreshQueuedFollowUps: true,
      };
    case 'queued_resume_failed':
      return {
        severity: 'info',
        message:
          'Message queued. Auto-resume failed; start a new agent task to continue.',
        refreshQueuedFollowUps: false,
      };
    case 'not_required':
    case 'queued_without_wake':
    case 'resumed':
    case 'resume_in_flight':
    case 'active_or_resuming':
      return { severity: 'none' };
  }
}

/**
 * Compatibility view for tool paths that only need to know whether the queued
 * item survived. UI callers should prefer {@link wakeQueuedFollowUpStream}.
 */
export async function wakeOrReleaseQueuedStream(
  streamId: StreamTabId,
  result: SendFollowUpResult,
  session?: SessionHandle,
): Promise<boolean> {
  return (
    (await wakeQueuedFollowUpStream(streamId, result, undefined, session))
      .kind !== 'dropped'
  );
}

const logger = createChannelTrace('ToolUseFollowUp');
const followUpSentObservers = new Set<(streamId: StreamTabId) => void>();

export function onFollowUpSent(
  observer: (streamId: StreamTabId) => void,
): () => void {
  followUpSentObservers.add(observer);
  return () => {
    followUpSentObservers.delete(observer);
  };
}

export function notifyFollowUpSent(
  streamId: StreamTabId,
  session?: SessionHandle,
): void {
  for (const observer of followUpSentObservers) {
    try {
      observer(streamId);
    } catch (err) {
      logger.warn(`Follow-up sent observer threw for stream ${streamId}`, {
        data: err,
      });
    }
  }
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
 * Send a follow-up message to a tool-use session.
 *
 * Routes based on session state:
 * 1. Active agent: direct append → { status: 'sent' }
 * 2. Resuming/Waiting session: queue for later → { status: 'queued' }
 * 3. No session found → { status: 'no_session' }
 *
 * Items queued for WAITING sessions are picked up when user resumes.
 *
 * `session` defaults to {@link currentSession} so in-run callers (binder send,
 * bash, delegation, CLI session loop, inquiry continuation) resolve the active
 * run's session via the ALS and stay byte-identical. HOST-PATH callers that
 * run OUTSIDE any run ALS (e.g. the desktop progress-view IPC handler, whose
 * runs are tracked in a per-window session, not the process default) MUST pass
 * their owning session, or the run's handle is looked up in the wrong registry
 * and a live follow-up is dropped as `no_session`.
 */
export function sendFollowUp(
  streamId: StreamTabId,
  followUp: FollowUpQueueInput,
): Promise<SendFollowUpResult>;
export function sendFollowUp(
  streamId: StreamTabId,
  followUp: FollowUpQueueInput,
  mediaFiles: undefined,
  displayText: undefined,
  session?: SessionHandle,
): Promise<SendFollowUpResult>;
export function sendFollowUp(
  streamId: StreamTabId,
  followUp: string,
  mediaFiles?: readonly string[],
  displayText?: string,
  session?: SessionHandle,
): Promise<SendFollowUpResult>;
export async function sendFollowUp(
  streamId: StreamTabId,
  followUp: string | FollowUpQueueInput,
  mediaFiles?: readonly string[],
  displayText?: string,
  session?: SessionHandle,
): Promise<SendFollowUpResult> {
  const ownerSession = session ?? currentSession();
  const target = ownerSession.executions.getToolUseFollowUpTarget(streamId);
  const item =
    typeof followUp === 'string'
      ? { text: followUp, mediaFiles, displayText }
      : followUp;

  if (target.kind === 'active') {
    target.context.session.appendFollowUp(item);
    notifyFollowUpSent(streamId, ownerSession);
    return { status: 'sent' };
  }

  if (target.kind === 'queue') {
    // children_running reopens a queue sealed by session disposal; callers
    // must auto-resume the parent or release again to avoid stale delivery.
    ownerSession.followUps.enqueue(streamId, item, {
      createIfMissing: true,
      force: target.reason === 'children_running',
    });
    return { status: 'queued', reason: target.reason };
  }

  // No active/waiting session found - caller should handle UI notification
  logger.warn(
    `No active session for follow-up on stream ${streamId}. Status: ${target.streamStatus}`,
  );
  return { status: 'no_session', streamStatus: target.streamStatus };
}
