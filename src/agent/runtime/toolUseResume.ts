import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { shouldProbePersistedFlowForFollowUp } from '@agent/runtime/followUpResumeDetection';
import { hasPersistedFlowRecord } from '@agent/storage/detectWaitingStreams';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

import { emitQueuedFollowUps } from './queuedFollowUps';
import { StreamStatusService } from './StreamStatusService';

const persistedWaitingDetections = new Set<StreamTabId>();

export interface PersistedToolUseWaitingDetectionRequest {
  readonly streamId: StreamTabId;
  readonly executionId: string | undefined;
  readonly runtimeHost: AgentRuntimeHost;
}

export interface ToolUseResumePreparationRequest {
  readonly streamId: StreamTabId;
  readonly runtimeHost: AgentRuntimeHost;
  readonly followUp?: string;
}

export interface ToolUseResumePreparation {
  readonly streamId: StreamTabId;
  readonly followUps: readonly FollowUpQueueInput[];
}

export interface ToolUseResumeFollowUpRestoreRequest extends ToolUseResumePreparation {
  readonly runtimeHost: AgentRuntimeHost;
}

export interface ToolUseResumeFinishRequest {
  readonly streamId: StreamTabId;
  readonly runtimeHost: AgentRuntimeHost;
}

/**
 * Detect a persisted waiting tool-use session and mark the stream WAITING.
 *
 * Hosts supply the execution id because the visible progress store owns that
 * lookup; the runtime owns the stream-status transition once persistence
 * confirms that a resumable tool-use flow exists.
 */
export async function detectPersistedToolUseWaitingSession({
  streamId,
  executionId,
  runtimeHost,
}: PersistedToolUseWaitingDetectionRequest): Promise<boolean> {
  const currentStatus = StreamStatusService.get(streamId);
  if (currentStatus === STREAM_STATUS.WAITING) return true;
  if (!shouldProbePersistedFlowForFollowUp(currentStatus)) return false;
  if (!executionId || persistedWaitingDetections.has(streamId)) return false;

  persistedWaitingDetections.add(streamId);
  try {
    const hasFlow = await hasPersistedFlowRecord(executionId);
    if (hasFlow) {
      StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
        runtimeHost,
      });
    }
    return hasFlow;
  } finally {
    persistedWaitingDetections.delete(streamId);
  }
}

/** Prepare a snapshot resume by entering RESUMING and draining queued input. */
export function prepareToolUseResume({
  streamId,
  runtimeHost,
  followUp,
}: ToolUseResumePreparationRequest): ToolUseResumePreparation | null {
  if (StreamStatusService.isActiveOrResuming(streamId)) {
    return null;
  }

  ToolUseFollowUpQueue.acquire(streamId);
  StreamStatusService.set(streamId, STREAM_STATUS.RESUMING, {
    runtimeHost,
  });

  const explicitFollowUps: readonly FollowUpQueueInput[] =
    followUp !== undefined ? [{ text: followUp, origin: 'user' }] : [];
  const followUps = [
    ...explicitFollowUps,
    ...ToolUseFollowUpQueue.drainItems(streamId),
  ];
  emitQueuedFollowUps(runtimeHost, streamId);

  return { streamId, followUps };
}

/** Restore drained resume input after a failed snapshot resume. */
export function restoreToolUseResumeFollowUps({
  streamId,
  runtimeHost,
  followUps,
}: ToolUseResumeFollowUpRestoreRequest): void {
  for (const item of followUps) {
    ToolUseFollowUpQueue.enqueue(streamId, item, { force: true });
  }
  if (followUps.length > 0) {
    emitQueuedFollowUps(runtimeHost, streamId);
  }
}

/** If a resume attempt did not take ownership, return the stream to WAITING. */
export function finishToolUseResume({
  streamId,
  runtimeHost,
}: ToolUseResumeFinishRequest): void {
  if (StreamStatusService.get(streamId) === STREAM_STATUS.RESUMING) {
    StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
      runtimeHost,
    });
  }
}
