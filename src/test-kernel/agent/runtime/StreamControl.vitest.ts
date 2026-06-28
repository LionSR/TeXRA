import { afterEach, describe, expect, it, vi } from 'vitest';

const detectWaitingStreamsMock = vi.hoisted(() => vi.fn());

vi.mock('@agent/storage/detectWaitingStreams', () => ({
  detectWaitingStreams: detectWaitingStreamsMock,
}));

import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  clearAllRuntimeStreamStatuses,
  clearRuntimeStreamStatus,
  getRuntimeStreamStatus,
  getRuntimeStreamStatusSnapshot,
  isRuntimeStreamActiveOrResuming,
  isRuntimeStreamInFlight,
  markRuntimeRunningStreamsStopped,
  onRuntimeStreamStatusChange,
  recoverRuntimeRunningStreamsFromPersistedState,
  requestKillExecution,
  requestRuntimeStreamStop,
  setRuntimeStreamStatus,
  setRuntimeStreamStatusSilently,
} from '@agent/runtime/streamControl';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import {
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

function createRecordingHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

describe('runtime stream control commands', () => {
  afterEach(() => {
    detectWaitingStreamsMock.mockReset();
  });

  it('requests runtime-owned stopping of a visible stream', () => {
    const session = new SessionHandle();
    const streamId = 'stream-control-stop' as StreamTabId;
    const host = createRecordingHost();
    const interrupt = vi.fn();
    const clearRetryRequest = vi.spyOn(
      session.coordinators,
      'clearRetryRequest',
    );

    try {
      session.interrupts.register(streamId, { interrupt });

      const result = requestRuntimeStreamStop({
        streamId,
        clearRetryRequest: true,
        runtimeHost: host,
        session,
      });

      expect(result).toEqual({
        streamId,
        status: 'stopped',
        clearedRetryRequest: true,
      });
      expect(clearRetryRequest).toHaveBeenCalledWith(streamId);
      expect(interrupt).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
    }
  });

  it('reports marked_stopped when the host repairs an untracked stream', () => {
    const session = new SessionHandle();
    const streamId = 'stream-control-mark-untracked-stopped' as StreamTabId;
    const host = createRecordingHost();

    try {
      const result = requestRuntimeStreamStop({
        streamId,
        runtimeHost: host,
        session,
      });

      expect(result).toEqual({
        streamId,
        status: 'marked_stopped',
        clearedRetryRequest: false,
      });
      expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.STOPPED);
      expect(host.emit).toHaveBeenCalledWith(
        'updateStreamStatus',
        expect.objectContaining({
          streamId,
          status: STREAM_STATUS.STOPPED,
        }),
      );
    } finally {
      StreamStatusService.clear(streamId, { emit: false });
      session.dispose();
    }
  });

  it('requests runtime-owned killing of a tracked execution', () => {
    const session = new SessionHandle();
    const streamId = 'stream-control-kill' as StreamTabId;
    const executionId = 'exec-stream-control-kill';
    const host = createRecordingHost();
    const interrupt = vi.fn();

    try {
      session.interrupts.register(streamId, { interrupt });
      session.executions.track(
        new AgentExecutionHandle(
          executionId,
          streamId,
          streamId,
          'test-agent',
          'toolUse',
          host,
        ),
      );

      const killed = requestKillExecution({ executionId, session });

      expect(killed).toBe(true);
      expect(interrupt).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
    }
  });

  it('projects whether a runtime stream is in flight', () => {
    const streamId = 'stream-control-in-flight' as StreamTabId;

    try {
      StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, {
        emit: false,
      });

      expect(isRuntimeStreamInFlight(streamId)).toBe(true);

      StreamStatusService.set(streamId, STREAM_STATUS.STOPPED, {
        emit: false,
      });

      expect(isRuntimeStreamInFlight(streamId)).toBe(false);
    } finally {
      StreamStatusService.clear(streamId, { emit: false });
    }
  });

  it('projects whether a runtime stream is active or resuming', () => {
    const streamId = 'stream-control-active-resuming' as StreamTabId;

    try {
      StreamStatusService.set(streamId, STREAM_STATUS.RESUMING, {
        emit: false,
      });

      expect(isRuntimeStreamActiveOrResuming(streamId)).toBe(true);

      StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
        emit: false,
      });

      expect(isRuntimeStreamActiveOrResuming(streamId)).toBe(false);
    } finally {
      StreamStatusService.clear(streamId, { emit: false });
    }
  });

  it('subscribes to runtime stream-status changes', () => {
    const streamId = 'stream-control-status-subscribe' as StreamTabId;
    const listener = vi.fn();
    const unsubscribe = onRuntimeStreamStatusChange(listener);

    try {
      StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, {
        runtimeHost: createRecordingHost(),
      });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId,
          status: STREAM_STATUS.RUNNING,
        }),
      );
    } finally {
      unsubscribe();
      StreamStatusService.clear(streamId, { emit: false });
    }
  });

  it('sets, snapshots, and clears runtime stream statuses', () => {
    const streamId = 'stream-control-status-snapshot' as StreamTabId;
    const host = createRecordingHost();

    try {
      setRuntimeStreamStatus({
        streamId,
        status: STREAM_STATUS.RUNNING,
        runtimeHost: host,
      });

      expect(getRuntimeStreamStatus(streamId)).toBe(STREAM_STATUS.RUNNING);
      expect(host.emit).toHaveBeenCalledWith(
        'updateStreamStatus',
        expect.objectContaining({
          streamId,
          status: STREAM_STATUS.RUNNING,
        }),
      );

      expect(getRuntimeStreamStatusSnapshot().get(streamId)).toBe(
        STREAM_STATUS.RUNNING,
      );

      clearRuntimeStreamStatus(streamId);

      expect(getRuntimeStreamStatusSnapshot().has(streamId)).toBe(false);

      setRuntimeStreamStatusSilently(streamId, STREAM_STATUS.WAITING);
      clearAllRuntimeStreamStatuses();

      expect(getRuntimeStreamStatusSnapshot().has(streamId)).toBe(false);
    } finally {
      StreamStatusService.clear(streamId, { emit: false });
    }
  });

  it('marks running stream statuses stopped for shutdown', () => {
    const stoppedStream = 'stream-control-mark-stopped' as StreamTabId;

    try {
      setRuntimeStreamStatusSilently(stoppedStream, STREAM_STATUS.RUNNING);
      markRuntimeRunningStreamsStopped();

      expect(StreamStatusService.get(stoppedStream)).toBe(
        STREAM_STATUS.STOPPED,
      );
    } finally {
      StreamStatusService.clear(stoppedStream, { emit: false });
    }
  });

  it('detects persisted waiting streams and repairs running statuses after restart', async () => {
    const waitingStream = 'stream-control-recover-waiting' as StreamTabId;
    const erroredStream = 'stream-control-recover-error' as StreamTabId;
    const waitingExecution = 'waiting-exec' as ExecutionId;
    const erroredExecution = 'errored-exec' as ExecutionId;
    const executionIdsByStream = new Map<StreamTabId, ExecutionId>([
      [waitingStream, waitingExecution],
      [erroredStream, erroredExecution],
    ]);

    try {
      setRuntimeStreamStatusSilently(waitingStream, STREAM_STATUS.RUNNING);
      setRuntimeStreamStatusSilently(erroredStream, STREAM_STATUS.RUNNING);
      detectWaitingStreamsMock.mockResolvedValue(new Set([waitingStream]));

      const recovery =
        await recoverRuntimeRunningStreamsFromPersistedState(
          executionIdsByStream,
        );

      expect(recovery).toEqual({
        waitingStreams: [waitingStream],
        erroredStreams: [erroredStream],
      });
      expect(detectWaitingStreamsMock).toHaveBeenCalledWith(
        executionIdsByStream,
      );
      expect(StreamStatusService.get(waitingStream)).toBe(
        STREAM_STATUS.WAITING,
      );
      expect(StreamStatusService.get(erroredStream)).toBe(STREAM_STATUS.ERROR);
    } finally {
      StreamStatusService.clear(waitingStream, { emit: false });
      StreamStatusService.clear(erroredStream, { emit: false });
    }
  });
});
