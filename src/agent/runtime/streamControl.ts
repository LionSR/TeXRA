import { detectWaitingStreams } from '@agent/storage/detectWaitingStreams';
import { isInFlightStatus } from '@common/constants/streamStatus';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import {
  type ExecutionId,
  STREAM_STATUS,
  type StreamStatus,
  type StreamTabId,
} from '@shared/schemas';

import { currentSession, type SessionHandle } from './SessionHandle';
import {
  StreamStatusService,
  type StreamStatusChange,
} from './StreamStatusService';
import type { KillExecutionOptions } from './executionRegistry';

export type RuntimeStreamStatusChange = StreamStatusChange;

export type RuntimeStreamStopStatus =
  | 'stopped'
  | 'marked_stopped'
  | 'not_found';

export interface RuntimeStreamStopResult {
  readonly streamId: StreamTabId;
  readonly status: RuntimeStreamStopStatus;
  readonly clearedRetryRequest: boolean;
}

export interface RuntimeStreamStopRequest {
  readonly streamId: StreamTabId;
  readonly clearRetryRequest?: boolean;
  readonly detachActiveChildren?: boolean;
  readonly runtimeHost?: AgentRuntimeHost;
  readonly session?: SessionHandle;
}

export interface KillExecutionRequest extends KillExecutionOptions {
  readonly executionId: string;
  readonly session?: SessionHandle;
}

export interface RuntimeRunningStreamRecovery {
  readonly waitingStreams: StreamTabId[];
  readonly erroredStreams: StreamTabId[];
}

export interface RuntimeStreamStatusRequest {
  readonly streamId: StreamTabId;
  readonly status: StreamStatus;
  readonly runtimeHost: AgentRuntimeHost;
}

/** Request runtime-owned stopping of a visible agent stream. */
export function requestRuntimeStreamStop({
  streamId,
  clearRetryRequest,
  detachActiveChildren,
  runtimeHost,
  session = currentSession(),
}: RuntimeStreamStopRequest): RuntimeStreamStopResult {
  const shouldClearRetryRequest = clearRetryRequest === true;
  if (shouldClearRetryRequest) {
    session.coordinators.clearRetryRequest(streamId);
  }
  const stopped = session.executions.stopAgentStream(streamId, {
    detachActiveChildren,
    runtimeHost,
  });
  return {
    streamId,
    status: stopped ? 'stopped' : runtimeHost ? 'marked_stopped' : 'not_found',
    clearedRetryRequest: shouldClearRetryRequest,
  };
}

/** Request runtime-owned termination of a tracked execution. */
export function requestKillExecution({
  executionId,
  detachActiveChildren,
  session = currentSession(),
}: KillExecutionRequest): boolean {
  return session.executions.kill(executionId, { detachActiveChildren });
}

/** Return whether the runtime still considers a stream protected from eviction. */
export function isRuntimeStreamInFlight(streamId: StreamTabId): boolean {
  return isInFlightStatus(StreamStatusService.get(streamId));
}

/** Return whether a stream is actively running or entering a resume cycle. */
export function isRuntimeStreamActiveOrResuming(
  streamId: StreamTabId,
): boolean {
  return StreamStatusService.isActiveOrResuming(streamId);
}

/** Return the current runtime stream status for one stream. */
export function getRuntimeStreamStatus(
  streamId: StreamTabId,
): StreamStatus | undefined {
  return StreamStatusService.get(streamId);
}

/** Return a copy of the runtime stream-status snapshot. */
export function getRuntimeStreamStatusSnapshot(): Map<
  StreamTabId,
  StreamStatus
> {
  return StreamStatusService.getAll();
}

/** Set a stream status and notify the owning host. */
export function setRuntimeStreamStatus({
  streamId,
  status,
  runtimeHost,
}: RuntimeStreamStatusRequest): void {
  StreamStatusService.set(streamId, status, { runtimeHost });
}

/** Set a stream status without emitting a host event. */
export function setRuntimeStreamStatusSilently(
  streamId: StreamTabId,
  status: StreamStatus,
): void {
  StreamStatusService.set(streamId, status, { emit: false });
}

/** Clear one runtime stream status without emitting a host event. */
export function clearRuntimeStreamStatus(streamId: StreamTabId): void {
  StreamStatusService.clear(streamId, { emit: false });
}

/** Clear all runtime stream statuses without emitting host events. */
export function clearAllRuntimeStreamStatuses(): void {
  StreamStatusService.clearAll({ emit: false });
}

/** Mark currently running streams as stopped during shutdown/cancel repair. */
export function markRuntimeRunningStreamsStopped(): void {
  for (const [streamId, status] of StreamStatusService.entries()) {
    if (status === STREAM_STATUS.RUNNING) {
      StreamStatusService.set(streamId, STREAM_STATUS.STOPPED, {
        emit: false,
      });
    }
  }
}

/** Recover persisted RUNNING statuses after host restart. */
export async function recoverRuntimeRunningStreamsFromPersistedState(
  executionIdsByStream: ReadonlyMap<StreamTabId, ExecutionId>,
): Promise<RuntimeRunningStreamRecovery> {
  const waitingStreams = await detectWaitingStreams(executionIdsByStream);
  return recoverRuntimeRunningStreamsAfterRestart(waitingStreams);
}

function recoverRuntimeRunningStreamsAfterRestart(
  waitingStreams: ReadonlySet<StreamTabId>,
): RuntimeRunningStreamRecovery {
  const restoredWaiting: StreamTabId[] = [];
  const erroredStreams: StreamTabId[] = [];

  for (const [streamId, status] of StreamStatusService.entries()) {
    if (status !== STREAM_STATUS.RUNNING) continue;

    if (waitingStreams.has(streamId)) {
      StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
        emit: false,
      });
      restoredWaiting.push(streamId);
      continue;
    }

    StreamStatusService.set(streamId, STREAM_STATUS.ERROR, {
      emit: false,
    });
    erroredStreams.push(streamId);
  }

  return { waitingStreams: restoredWaiting, erroredStreams };
}

/** Subscribe to runtime stream-status changes without exposing the status store. */
export function onRuntimeStreamStatusChange(
  listener: (change: RuntimeStreamStatusChange) => void,
): () => void {
  return StreamStatusService.onDidChange(listener);
}
