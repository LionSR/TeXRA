/**
 * Shared mechanics for delivering child-run results to an owning parent stream.
 *
 * Callers own their result format, duplicate-delivery policy, and warning text.
 * This module owns only the common boundary actions: best-effort report writes,
 * follow-up enqueue, and optional wake-or-release of a force-opened queue.
 */

// Local imports
import { getExecutionStore, type ResultMeta } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  sendFollowUp,
  wakeOrReleaseQueuedStream,
  type SendFollowUpResult,
} from '@agent/followUp/ToolUseFollowUp';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

export type ChildRunDeliveryResult =
  | { kind: 'delivered' }
  | { kind: 'no_session'; streamStatus: string | undefined }
  | { kind: 'dropped' };

/**
 * Outcome of the fast "enqueue" half of delivery — appending to (or queueing
 * on) the parent stream's follow-up queue. Never waits on a resumed parent
 * turn; safe to await before a caller finalizes its own child.
 */
export type ChildRunEnqueueResult =
  | { kind: 'enqueued'; sendResult: SendFollowUpResult }
  | { kind: 'no_session'; streamStatus: string | undefined };

export type ChildRunReportResult =
  { kind: 'persisted' } | { kind: 'failed'; err: unknown };

export type ChildRunResultMetaResult =
  | { kind: 'persisted' }
  | { kind: 'skipped' }
  | { kind: 'failed'; err: unknown };

export async function persistChildRunReport(
  executionId: ExecutionId,
  message: string,
): Promise<ChildRunReportResult> {
  try {
    await getExecutionStore(executionId).writeReport(message);
    return { kind: 'persisted' };
  } catch (err) {
    return { kind: 'failed', err };
  }
}

export async function persistChildRunResultMeta(
  executionId: ExecutionId,
  resultMeta: ResultMeta | undefined,
): Promise<ChildRunResultMetaResult> {
  if (!resultMeta) {
    return { kind: 'skipped' };
  }
  try {
    await getExecutionStore(executionId).writeResultMeta(resultMeta);
    return { kind: 'persisted' };
  } catch (err) {
    return { kind: 'failed', err };
  }
}

/**
 * Enqueue a child-run result on the parent stream's follow-up queue. Never
 * awaits a resumed parent turn — callers that must finalize their own child
 * before the wake step (see {@link wakeChildRunFollowUp}) call this first.
 */
export async function enqueueChildRunFollowUp(params: {
  readonly targetStreamId: StreamTabId;
  readonly followUp: FollowUpQueueInput;
  readonly session: SessionHandle;
}): Promise<ChildRunEnqueueResult> {
  const result = await sendFollowUp(
    params.targetStreamId,
    params.followUp,
    undefined,
    undefined,
    params.session,
  );
  return result.status === 'no_session'
    ? { kind: 'no_session', streamStatus: result.streamStatus }
    : { kind: 'enqueued', sendResult: result };
}

/**
 * Wake (or release) the parent stream for a result already enqueued via
 * {@link enqueueChildRunFollowUp}. This is the half that can await an entire
 * resumed parent turn (`agentResume.tryResumeStream` → … →
 * `resumeToolUseFromResumeData`) — call it only after any of this child's own
 * finalization work is done, so a resumed parent that immediately waits on
 * this child's execution never races its own wake.
 */
export async function wakeChildRunFollowUp(
  targetStreamId: StreamTabId,
  enqueueResult: ChildRunEnqueueResult,
  session: SessionHandle,
): Promise<ChildRunDeliveryResult> {
  if (enqueueResult.kind === 'no_session') {
    return { kind: 'no_session', streamStatus: enqueueResult.streamStatus };
  }
  return (await wakeOrReleaseQueuedStream(
    targetStreamId,
    enqueueResult.sendResult,
    session,
  ))
    ? { kind: 'delivered' }
    : { kind: 'dropped' };
}

/**
 * Enqueue-then-wake in one call, for callers with no finalization step to
 * order the wake after (e.g. a live-progress notification, or a wake-failure
 * error report). Callers that finalize their own child around delivery use
 * {@link enqueueChildRunFollowUp} and {@link wakeChildRunFollowUp} directly,
 * with the finalize sandwiched between them.
 */
export async function deliverChildRunFollowUp(params: {
  readonly targetStreamId: StreamTabId;
  readonly followUp: FollowUpQueueInput;
  readonly session: SessionHandle;
  readonly wake?: boolean;
}): Promise<ChildRunDeliveryResult> {
  const enqueueResult = await enqueueChildRunFollowUp(params);
  if (enqueueResult.kind === 'no_session') {
    return { kind: 'no_session', streamStatus: enqueueResult.streamStatus };
  }
  if (!params.wake) {
    return { kind: 'delivered' };
  }
  return wakeChildRunFollowUp(
    params.targetStreamId,
    enqueueResult,
    params.session,
  );
}
