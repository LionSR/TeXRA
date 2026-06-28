import { shouldProbePersistedFlowForFollowUp } from '@agent/runtime/followUpResumeDetection';
import { hasPersistedFlowRecord } from '@agent/storage/detectWaitingStreams';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import {
  type QueuedFollowUpWakeResult,
  sendFollowUp,
  type SendFollowUpResult,
  wakeQueuedFollowUpStream,
} from '@agent/followUp/ToolUseFollowUp';
import type { ToolUseFollowUpQueueReason } from '@agent/runtime/executionRegistry';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import {
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

import { publishRuntimeQueuedFollowUps } from './queuedFollowUps';
import { StreamStatusService } from './StreamStatusService';

const persistedWaitingDetections = new Set<StreamTabId>();

export type RuntimeFollowUpOutcome =
  | 'sent'
  | 'queued'
  | 'dropped'
  | 'no_session';

export interface RuntimeFollowUpNotice {
  readonly severity: 'information' | 'warning';
  readonly message: string;
}

export interface RuntimeFollowUpResult {
  readonly outcome: RuntimeFollowUpOutcome;
  readonly accepted: boolean;
  readonly queueReason?: ToolUseFollowUpQueueReason;
  readonly streamStatus?: string;
  readonly wakeStatus?: QueuedFollowUpWakeResult['status'];
  readonly notice?: RuntimeFollowUpNotice;
}

export interface RuntimeFollowUpRequest {
  readonly streamId: StreamTabId;
  readonly text: string | FollowUpQueueInput;
  readonly mediaFiles?: readonly string[];
  readonly displayText?: string;
  readonly runtimeHost?: AgentRuntimeHost;
  readonly session?: SessionHandle;
  readonly persistedWaitingExecutionId?: ExecutionId;
  readonly wakeQueuedStream?: boolean;
}

export function listRuntimeQueuedFollowUpMessages(
  streamId: StreamTabId,
): string[] {
  return ToolUseFollowUpQueue.getAll(streamId);
}

/**
 * Send a user follow-up to the runtime-owned tool-use session for a stream.
 *
 * When a host is supplied, this command also publishes the queue projection so
 * callers do not need to remember which result states mutate queued input. A
 * caller may also ask the runtime to detect a persisted WAITING state and wake
 * queued input through the host-neutral resume port.
 */
export async function requestRuntimeFollowUp({
  streamId,
  text,
  mediaFiles,
  displayText,
  runtimeHost,
  session,
  persistedWaitingExecutionId,
  wakeQueuedStream,
}: RuntimeFollowUpRequest): Promise<RuntimeFollowUpResult> {
  if (runtimeHost && persistedWaitingExecutionId !== undefined) {
    await detectPersistedToolUseWaitingSession({
      streamId,
      executionId: persistedWaitingExecutionId,
      runtimeHost,
    });
  }

  const result =
    typeof text === 'string'
      ? await sendFollowUp(streamId, text, mediaFiles, displayText, session)
      : await sendFollowUp(streamId, text, undefined, undefined, session);
  if (runtimeHost && (result.status === 'sent' || result.status === 'queued')) {
    publishRuntimeQueuedFollowUps(runtimeHost, streamId);
  }
  if (wakeQueuedStream === true) {
    return resolveWakeResult(streamId, result, runtimeHost);
  }
  return interpretFollowUpResult(result);
}

async function detectPersistedToolUseWaitingSession({
  streamId,
  executionId,
  runtimeHost,
}: {
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId | undefined;
  readonly runtimeHost: AgentRuntimeHost;
}): Promise<boolean> {
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

async function resolveWakeResult(
  streamId: StreamTabId,
  result: SendFollowUpResult,
  runtimeHost: AgentRuntimeHost | undefined,
): Promise<RuntimeFollowUpResult> {
  const interpreted = interpretFollowUpResult(result);
  const wake = await wakeQueuedFollowUpStream(streamId, result);

  if (wake.status === 'dropped') {
    if (runtimeHost) publishRuntimeQueuedFollowUps(runtimeHost, streamId);
    return {
      outcome: 'dropped',
      accepted: false,
      queueReason:
        result.status === 'queued' ? result.reason : interpreted.queueReason,
      wakeStatus: wake.status,
      ...(result.status === 'no_session'
        ? { streamStatus: result.streamStatus }
        : {}),
      notice: {
        severity: 'warning',
        message:
          'Message dropped -- no session available to receive it. Start a new agent task to continue.',
      },
    };
  }

  if (
    wake.status === 'queued' &&
    result.status === 'queued' &&
    result.reason === 'waiting'
  ) {
    return {
      ...interpreted,
      wakeStatus: wake.status,
      notice: {
        severity: 'information',
        message:
          'Message queued. Auto-resume failed -- start a new agent task to continue.',
      },
    };
  }

  return { ...interpreted, wakeStatus: wake.status };
}

function interpretFollowUpResult(
  result: SendFollowUpResult,
): RuntimeFollowUpResult {
  switch (result.status) {
    case 'sent':
      return { outcome: 'sent', accepted: true };
    case 'queued':
      return {
        outcome: 'queued',
        accepted: true,
        queueReason: result.reason,
      };
    case 'no_session':
      return {
        outcome: 'no_session',
        accepted: false,
        streamStatus: result.streamStatus,
        notice: {
          severity: 'warning',
          message: 'No active session. Start a new agent task to continue.',
        },
      };
  }
}
