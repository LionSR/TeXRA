/** Shared persistence and parent-continuation delivery for child runs. */
import {
  type ChildTurnState,
  getExecutionStore,
  type ResultMeta,
} from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
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

export async function persistChildRunResultMeta(
  executionId: ExecutionId,
  resultMeta: ResultMeta,
): Promise<ChildRunReportResult> {
  try {
    await getExecutionStore(executionId).writeResultMeta(resultMeta);
    return { kind: 'persisted' };
  } catch (err) {
    return { kind: 'failed', err };
  }
}

/**
 * Persist turn attribution for the report/result slots (#9531). Unlike the
 * report and manifest, this is attribution metadata: a failure downgrades
 * /report//result turn labeling but never the delivered result itself, so it
 * does not mark the lease undurable.
 */
export async function persistChildRunTurnState(
  executionId: ExecutionId,
  state: ChildTurnState,
): Promise<ChildRunReportResult> {
  try {
    await getExecutionStore(executionId).writeTurnState(state);
    return { kind: 'persisted' };
  } catch (err) {
    return { kind: 'failed', err };
  }
}

export async function deliverChildRunFollowUp(params: {
  readonly targetStreamId: StreamTabId;
  readonly followUp: FollowUpQueueInput;
  readonly session: SessionHandle;
  readonly mode?: 'continuation' | 'live_notification' | 'child_delivery';
}): Promise<ChildRunDeliveryResult> {
  const result = await submitFollowUp(params.targetStreamId, params.followUp, {
    session: params.session,
    mode: params.mode ?? 'child_delivery',
  });
  if (result.status === 'no_session') {
    return { kind: 'no_session', streamStatus: result.streamStatus };
  }
  return result.status === 'dropped'
    ? { kind: 'dropped' }
    : { kind: 'delivered' };
}
