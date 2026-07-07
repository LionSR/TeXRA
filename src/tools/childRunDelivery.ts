/**
 * Shared mechanics for delivering child-run results to an owning parent stream.
 *
 * Callers own their result format, duplicate-delivery policy, and warning text.
 * This module owns only the common boundary actions: best-effort report writes,
 * follow-up enqueue, and optional wake-or-release of a force-opened queue.
 */

// Local imports - agent
import { getExecutionStore, type ResultMeta } from '@agent/storage';
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

export type ChildRunResultMetaResult =
  | { kind: 'persisted' }
  | { kind: 'skipped' }
  | { kind: 'failed'; err: unknown };

export interface ChildRunTerminalDeliveryGate {
  beginDelivery(): boolean;
  completeDelivery(): void;
  failDelivery(): void;
}

type ChildRunTerminalPersistence = {
  readonly report: ChildRunReportResult;
  readonly resultMeta: ChildRunResultMetaResult;
};

export type ChildRunTerminalDeliveryResult = ChildRunTerminalPersistence &
  (
    | { readonly kind: 'delivered' }
    | { readonly kind: 'duplicate' }
    | { readonly kind: 'no_target' }
    | { readonly kind: 'no_session'; readonly streamStatus: string | undefined }
    | { readonly kind: 'dropped' }
  );

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

/**
 * Persist and deliver a terminal child-run result.
 *
 * The result manifest is written before the parent wake so a resumed parent
 * can immediately read `/executions/{id}/result`. The report write is
 * best-effort and runs for every attempted terminal delivery, including
 * duplicates and missing parent targets, preserving the durable transcript.
 */
export async function deliverTerminalChildRun(params: {
  readonly executionId: ExecutionId;
  readonly message: string;
  readonly resultMeta?: ResultMeta;
  readonly targetStreamId: StreamTabId | undefined;
  readonly session: SessionHandle;
  readonly gate?: ChildRunTerminalDeliveryGate;
}): Promise<ChildRunTerminalDeliveryResult> {
  const resultMeta = await persistChildRunResultMeta(
    params.executionId,
    params.resultMeta,
  );
  const reportPromise = persistChildRunReport(
    params.executionId,
    params.message,
  );

  const persistence = async (): Promise<ChildRunTerminalPersistence> => ({
    report: await reportPromise,
    resultMeta,
  });

  if (params.gate && !params.gate.beginDelivery()) {
    return { kind: 'duplicate', ...(await persistence()) };
  }

  if (!params.targetStreamId) {
    params.gate?.failDelivery();
    return { kind: 'no_target', ...(await persistence()) };
  }

  let delivery: ChildRunDeliveryResult;
  try {
    delivery = await deliverChildRunFollowUp({
      targetStreamId: params.targetStreamId,
      followUp: { text: params.message, origin: 'subagent_result' },
      session: params.session,
      wake: true,
    });
  } catch (err) {
    params.gate?.failDelivery();
    await reportPromise;
    throw err;
  }

  if (delivery.kind === 'delivered') {
    params.gate?.completeDelivery();
    return { kind: 'delivered', ...(await persistence()) };
  }

  params.gate?.failDelivery();
  if (delivery.kind === 'no_session') {
    return {
      kind: 'no_session',
      streamStatus: delivery.streamStatus,
      ...(await persistence()),
    };
  }
  return { kind: 'dropped', ...(await persistence()) };
}
