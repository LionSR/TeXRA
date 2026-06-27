import { afterEach, describe, expect, it, vi } from 'vitest';

const detectWaitingStreamsMock = vi.hoisted(() => vi.fn());

vi.mock('@agent/storage/detectWaitingStreams', () => ({
  detectWaitingStreams: detectWaitingStreamsMock,
}));

import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  clearAllRuntimeStreamStatuses,
  clearRuntimeStreamStatus,
  detectRuntimeWaitingStreams,
  getRuntimeStreamStatus,
  getRuntimeStreamStatusSnapshot,
  isRuntimeStreamActiveOrResuming,
  isRuntimeStreamInFlight,
  markRuntimeRunningStreamsStopped,
  onRuntimeStreamStatusChange,
  recoverRuntimeRunningStreamsAfterRestart,
  releaseQueuedFollowUpsForStreams,
  requestKillExecution,
  requestStopStream,
  setRuntimeStreamStatus,
  setRuntimeStreamStatusSilently,
} from '@agent/runtime/streamControl';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
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

    try {
      session.interrupts.register(streamId, { interrupt });

      const stopped = requestStopStream({
        streamId,
        runtimeHost: host,
        session,
      });

      expect(stopped).toBe(true);
      expect(interrupt).toHaveBeenCalledOnce();
    } finally {
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

  it('releases queued follow-ups for removed streams', () => {
    const firstStream = 'stream-control-release-first' as StreamTabId;
    const secondStream = 'stream-control-release-second' as StreamTabId;

    const firstQueue = ToolUseFollowUpQueue.acquire(firstStream);
    const secondQueue = ToolUseFollowUpQueue.acquire(secondStream);
    firstQueue.enqueue({ text: 'First follow-up' });
    secondQueue.enqueue({ text: 'Second follow-up' });

    try {
      releaseQueuedFollowUpsForStreams([firstStream, secondStream]);

      expect(ToolUseFollowUpQueue.getAll(firstStream)).toEqual([]);
      expect(ToolUseFollowUpQueue.getAll(secondStream)).toEqual([]);
    } finally {
      ToolUseFollowUpQueue.release(firstStream);
      ToolUseFollowUpQueue.release(secondStream);
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

  it('repairs running stream statuses for shutdown and restart paths', () => {
    const stoppedStream = 'stream-control-mark-stopped' as StreamTabId;
    const waitingStream = 'stream-control-recover-waiting' as StreamTabId;
    const erroredStream = 'stream-control-recover-error' as StreamTabId;

    try {
      setRuntimeStreamStatusSilently(stoppedStream, STREAM_STATUS.RUNNING);
      markRuntimeRunningStreamsStopped();

      expect(StreamStatusService.get(stoppedStream)).toBe(
        STREAM_STATUS.STOPPED,
      );

      setRuntimeStreamStatusSilently(waitingStream, STREAM_STATUS.RUNNING);
      setRuntimeStreamStatusSilently(erroredStream, STREAM_STATUS.RUNNING);

      const recovery = recoverRuntimeRunningStreamsAfterRestart(
        new Set([waitingStream]),
      );

      expect(recovery).toEqual({
        waitingStreams: [waitingStream],
        erroredStreams: [erroredStream],
      });
      expect(StreamStatusService.get(waitingStream)).toBe(
        STREAM_STATUS.WAITING,
      );
      expect(StreamStatusService.get(erroredStream)).toBe(STREAM_STATUS.ERROR);
    } finally {
      StreamStatusService.clear(stoppedStream, { emit: false });
      StreamStatusService.clear(waitingStream, { emit: false });
      StreamStatusService.clear(erroredStream, { emit: false });
    }
  });

  it('detects waiting streams through the runtime boundary', async () => {
    const streamId = 'stream-control-detect-waiting' as StreamTabId;
    const executionId = 'abcdef123456' as ExecutionId;
    const executionIdsByStream = new Map([[streamId, executionId]]);
    const waiting = new Set([streamId]);
    detectWaitingStreamsMock.mockResolvedValue(waiting);

    await expect(
      detectRuntimeWaitingStreams(executionIdsByStream),
    ).resolves.toBe(waiting);
    expect(detectWaitingStreamsMock).toHaveBeenCalledWith(executionIdsByStream);
  });
});
