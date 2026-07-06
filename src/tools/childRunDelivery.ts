/**
 * Shared mechanics for delivering child-run results to an owning parent stream.
 *
 * Callers own their result format, duplicate-delivery policy, and warning text.
 * This module owns only the common boundary actions: best-effort report writes,
 * follow-up enqueue, and optional wake-or-release of a force-opened queue.
 */

// Local imports - agent
import { getExecutionStore } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  sendFollowUp,
  wakeOrReleaseQueuedStream,
} from '@agent/followUp/ToolUseFollowUp';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';

// Local imports - shared
import type { ExecutionId, StreamTabId } from '@shared/schemas';

export type ChildRunDeliveryResult =
  | { kind: 'delivered' }
  | { kind: 'no_session'; streamStatus: string | undefined }
  | { kind: 'dropped' };

export type ChildRunReportResult =
  { kind: 'persisted' } | { kind: 'failed'; err: unknown };

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

export async function deliverChildRunFollowUp(params: {
  readonly targetStreamId: StreamTabId;
  readonly followUp: FollowUpQueueInput;
  readonly session: SessionHandle;
  readonly wake?: boolean;
}): Promise<ChildRunDeliveryResult> {
  const result = await sendFollowUp(
    params.targetStreamId,
    params.followUp,
    undefined,
    undefined,
    params.session,
  );
  if (result.status === 'no_session') {
    return { kind: 'no_session', streamStatus: result.streamStatus };
  }
  if (!params.wake) {
    return { kind: 'delivered' };
  }
  return (await wakeOrReleaseQueuedStream(
    params.targetStreamId,
    result,
    params.session,
  ))
    ? { kind: 'delivered' }
    : { kind: 'dropped' };
}
