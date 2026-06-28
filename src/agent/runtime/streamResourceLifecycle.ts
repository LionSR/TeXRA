import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';
import {
  cleanupAllApprovals,
  cleanupApprovalsForStream,
  cleanupUnscopedApprovals,
} from '@tools/approval';
import { GoalStore } from '@tools/goal';

import { publishRuntimeQueuedFollowUps } from './queuedFollowUps';
import { currentSession, type SessionHandle } from './SessionHandle';

export type RuntimeDeletedStreamsApprovalScope = 'process' | 'session';

export interface ReleaseRuntimeDeletedStreamRequest {
  readonly streamId: StreamTabId;
  readonly session?: SessionHandle;
  readonly runtimeHost?: AgentRuntimeHost;
  readonly publishQueueProjection?: boolean;
}

export interface ReleaseRuntimeDeletedStreamsRequest {
  readonly streamIds: Iterable<StreamTabId>;
  readonly approvalScope: RuntimeDeletedStreamsApprovalScope;
  readonly session?: SessionHandle;
  readonly runtimeHost?: AgentRuntimeHost;
  readonly publishQueueProjection?: boolean;
}

/**
 * Release runtime-owned resources for one deleted stream.
 *
 * Host-owned view state, persisted sidecars, and backup files remain outside
 * this operation. Approval state, coordinator requests, and queued follow-ups
 * are one runtime transaction.
 */
export async function releaseRuntimeDeletedStream({
  streamId,
  session = currentSession(),
  runtimeHost,
  publishQueueProjection,
}: ReleaseRuntimeDeletedStreamRequest): Promise<void> {
  cleanupApprovalsForStream(streamId, session);
  releaseRuntimeDeletedStreamQueue({
    streamId,
    runtimeHost,
    publishQueueProjection,
  });
  await GoalStore.forget(streamId);
}

/**
 * Release runtime-owned resources for a delete-all operation.
 *
 * Extension delete-all uses `process` scope because it is a single-session
 * host. Desktop windows use `session` scope so sibling windows keep their
 * pending approvals and coordinator state.
 */
export async function releaseRuntimeDeletedStreams({
  streamIds,
  approvalScope,
  session = currentSession(),
  runtimeHost,
  publishQueueProjection,
}: ReleaseRuntimeDeletedStreamsRequest): Promise<void> {
  const streams = [...streamIds];

  if (approvalScope === 'process') {
    cleanupAllApprovals(session);
    for (const streamId of streams) {
      releaseRuntimeDeletedStreamQueue({
        streamId,
        runtimeHost,
        publishQueueProjection,
      });
    }
    await GoalStore.forgetMany(streams);
    return;
  }

  for (const streamId of streams) {
    cleanupApprovalsForStream(streamId, session);
    releaseRuntimeDeletedStreamQueue({
      streamId,
      runtimeHost,
      publishQueueProjection,
    });
  }
  cleanupUnscopedApprovals(runtimeHost);
  session.coordinators.cleanupAllRequests();
  await GoalStore.forgetMany(streams);
}

function releaseRuntimeDeletedStreamQueue({
  streamId,
  runtimeHost,
  publishQueueProjection,
}: {
  readonly streamId: StreamTabId;
  readonly runtimeHost: AgentRuntimeHost | undefined;
  readonly publishQueueProjection: boolean | undefined;
}): void {
  ToolUseFollowUpQueue.release(streamId);
  if (runtimeHost && publishQueueProjection === true) {
    publishRuntimeQueuedFollowUps(runtimeHost, streamId);
  }
}
