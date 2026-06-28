import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasPersistedFlowRecord: vi.fn(),
}));

vi.mock('@agent/storage/detectWaitingStreams', () => ({
  hasPersistedFlowRecord: mocks.hasPersistedFlowRecord,
}));

import { createFakePlatform } from '@test/support/FakePlatform';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import { requestRuntimeFollowUp } from '@agent/runtime/followUpCommands';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  clearRuntimeStreamStatus,
  setRuntimeStreamStatusSilently,
} from '@agent/runtime/streamControl';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

function createRecordingHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('runtime follow-up commands', () => {
  beforeEach(() => {
    mocks.hasPersistedFlowRecord.mockReset();
  });

  it('sends user follow-ups to the live tool-use flow for a stream', async () => {
    const session = new SessionHandle();
    const streamId = 'runtime-follow-up-stream' as StreamTabId;
    const host = createRecordingHost();
    const appended: FollowUpQueueInput[] = [];

    try {
      const handle = new AgentExecutionHandle(
        'runtime-follow-up-execution',
        streamId,
        streamId,
        'test-tool-use',
        'toolUse',
        host,
      );
      handle.attachToolUseFlow({
        session: {
          appendFollowUp: (followUp) => appended.push(followUp),
        },
        modelHandler: {
          supportsManualCompaction: true,
        },
        runtimeHost: host,
        requestImmediateCompaction: vi.fn(),
        modelSwitchDisabledReason: vi.fn(),
        switchModel: vi.fn(),
      });
      session.executions.track(handle);

      const result = await requestRuntimeFollowUp({
        streamId,
        text: 'Continue with the proof.',
        displayText: 'Continue.',
        mediaFiles: ['diagram.png'],
        runtimeHost: host,
        session,
      });

      expect(result).toEqual({ outcome: 'sent', accepted: true });
      expect(appended).toEqual([
        {
          text: 'Continue with the proof.',
          displayText: 'Continue.',
          mediaFiles: ['diagram.png'],
        },
      ]);
      expect(host.emit).toHaveBeenCalledWith('updateQueuedFollowUps', {
        streamId,
        messages: [],
      });
    } finally {
      session.dispose();
    }
  });

  it('queues waiting follow-ups and publishes the queue projection', async () => {
    const session = new SessionHandle();
    const streamId = 'runtime-follow-up-waiting' as StreamTabId;
    const host = createRecordingHost();

    try {
      setRuntimeStreamStatusSilently(streamId, STREAM_STATUS.WAITING);

      const result = await requestRuntimeFollowUp({
        streamId,
        text: 'Use the compactness lemma.',
        runtimeHost: host,
        session,
      });

      expect(result).toEqual({
        outcome: 'queued',
        accepted: true,
        queueReason: 'waiting',
      });
      expect(ToolUseFollowUpQueue.getAll(streamId)).toEqual([
        'Use the compactness lemma.',
      ]);
      expect(host.emit).toHaveBeenCalledWith('updateQueuedFollowUps', {
        streamId,
        messages: ['Use the compactness lemma.'],
      });
    } finally {
      session.dispose();
      clearRuntimeStreamStatus(streamId);
      ToolUseFollowUpQueue.release(streamId);
    }
  });

  it('detects persisted waiting tool-use flow data before queuing a follow-up', async () => {
    const session = new SessionHandle();
    const streamId = 'runtime-follow-up-persisted-waiting' as StreamTabId;
    const host = createRecordingHost();

    try {
      setRuntimeStreamStatusSilently(streamId, STREAM_STATUS.STOPPED);
      mocks.hasPersistedFlowRecord.mockResolvedValue(true);

      const result = await requestRuntimeFollowUp({
        streamId,
        text: 'Resume with this observation.',
        runtimeHost: host,
        session,
        persistedWaitingExecutionId: 'runtime-follow-up-persisted-execution',
      });

      expect(mocks.hasPersistedFlowRecord).toHaveBeenCalledWith(
        'runtime-follow-up-persisted-execution',
      );
      expect(result).toEqual({
        outcome: 'queued',
        accepted: true,
        queueReason: 'waiting',
      });
      expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.WAITING);
      expect(ToolUseFollowUpQueue.getAll(streamId)).toEqual([
        'Resume with this observation.',
      ]);
      expect(host.emit).toHaveBeenCalledWith(
        'updateStreamStatus',
        expect.objectContaining({
          streamId,
          status: STREAM_STATUS.WAITING,
        }),
      );
      expect(host.emit).toHaveBeenCalledWith('updateQueuedFollowUps', {
        streamId,
        messages: ['Resume with this observation.'],
      });
    } finally {
      session.dispose();
      clearRuntimeStreamStatus(streamId);
      ToolUseFollowUpQueue.release(streamId);
    }
  });

  it('deduplicates persisted waiting probes per session without sharing the lock across sessions', async () => {
    const sessionA = new SessionHandle();
    const sessionB = new SessionHandle();
    const streamId = 'runtime-follow-up-session-scoped-probe' as StreamTabId;
    const host = createRecordingHost();
    const firstProbe = deferred<boolean>();
    const secondProbe = deferred<boolean>();

    try {
      setRuntimeStreamStatusSilently(streamId, STREAM_STATUS.STOPPED);
      mocks.hasPersistedFlowRecord
        .mockReturnValueOnce(firstProbe.promise)
        .mockReturnValueOnce(secondProbe.promise);

      const firstSessionRequest = requestRuntimeFollowUp({
        streamId,
        text: 'first session message',
        runtimeHost: host,
        session: sessionA,
        persistedWaitingExecutionId: 'runtime-follow-up-session-scoped-exec-a',
      });
      const duplicateSameSessionRequest = requestRuntimeFollowUp({
        streamId,
        text: 'duplicate same session message',
        runtimeHost: host,
        session: sessionA,
        persistedWaitingExecutionId:
          'runtime-follow-up-session-scoped-exec-a-duplicate',
      });
      const secondSessionRequest = requestRuntimeFollowUp({
        streamId,
        text: 'second session message',
        runtimeHost: host,
        session: sessionB,
        persistedWaitingExecutionId: 'runtime-follow-up-session-scoped-exec-b',
      });

      await vi.waitFor(() => {
        expect(mocks.hasPersistedFlowRecord).toHaveBeenCalledTimes(2);
      });
      expect(mocks.hasPersistedFlowRecord).toHaveBeenNthCalledWith(
        1,
        'runtime-follow-up-session-scoped-exec-a',
      );
      expect(mocks.hasPersistedFlowRecord).toHaveBeenNthCalledWith(
        2,
        'runtime-follow-up-session-scoped-exec-b',
      );
      await expect(duplicateSameSessionRequest).resolves.toEqual({
        outcome: 'no_session',
        accepted: false,
        streamStatus: STREAM_STATUS.STOPPED,
        notice: {
          severity: 'warning',
          message: 'No active session. Start a new agent task to continue.',
        },
      });

      firstProbe.resolve(true);
      secondProbe.resolve(true);

      await expect(firstSessionRequest).resolves.toEqual({
        outcome: 'queued',
        accepted: true,
        queueReason: 'waiting',
      });
      await expect(secondSessionRequest).resolves.toEqual({
        outcome: 'queued',
        accepted: true,
        queueReason: 'waiting',
      });
    } finally {
      sessionA.dispose();
      sessionB.dispose();
      clearRuntimeStreamStatus(streamId);
      ToolUseFollowUpQueue.release(streamId);
    }
  });

  it('queues structured follow-up inputs without erasing provenance', async () => {
    const session = new SessionHandle();
    const streamId = 'runtime-follow-up-structured' as StreamTabId;
    const host = createRecordingHost();

    try {
      setRuntimeStreamStatusSilently(streamId, STREAM_STATUS.WAITING);

      const result = await requestRuntimeFollowUp({
        streamId,
        text: {
          text: '<subagent-result>done</subagent-result>',
          displayText: 'subagent result available',
          mediaFiles: ['artifact.png'],
          origin: 'subagent_result',
        },
        runtimeHost: host,
        session,
      });

      expect(result).toEqual({
        outcome: 'queued',
        accepted: true,
        queueReason: 'waiting',
      });
      expect(host.emit).toHaveBeenCalledWith('updateQueuedFollowUps', {
        streamId,
        messages: ['subagent result available'],
      });
      expect(ToolUseFollowUpQueue.drainItems(streamId)).toEqual([
        {
          text: '<subagent-result>done</subagent-result>',
          displayText: 'subagent result available',
          mediaFiles: ['artifact.png'],
          origin: 'subagent_result',
        },
      ]);
    } finally {
      session.dispose();
      clearRuntimeStreamStatus(streamId);
      ToolUseFollowUpQueue.release(streamId);
    }
  });

  it('uses the supplied session to find child runs for follow-up admission', async () => {
    const session = new SessionHandle();
    const parentStreamId = 'runtime-follow-up-session-parent' as StreamTabId;
    const childStreamId = 'runtime-follow-up-session-child' as StreamTabId;
    const host = createRecordingHost();

    try {
      session.executions.track(
        new AgentExecutionHandle(
          'runtime-follow-up-session-child-execution',
          parentStreamId,
          childStreamId,
          'test-subagent',
          'toolUse',
          host,
        ),
      );

      const result = await requestRuntimeFollowUp({
        streamId: parentStreamId,
        text: 'Use the child result.',
        runtimeHost: host,
        session,
      });

      expect(result).toEqual({
        outcome: 'queued',
        accepted: true,
        queueReason: 'children_running',
      });
      expect(ToolUseFollowUpQueue.getAll(parentStreamId)).toEqual([
        'Use the child result.',
      ]);
    } finally {
      session.dispose();
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('returns a warning result when no runtime session can receive the follow-up', async () => {
    const session = new SessionHandle();
    const streamId = 'runtime-follow-up-missing' as StreamTabId;

    try {
      setRuntimeStreamStatusSilently(streamId, STREAM_STATUS.STOPPED);

      const result = await requestRuntimeFollowUp({
        streamId,
        text: 'Are you there?',
        session,
      });

      expect(result).toEqual({
        outcome: 'no_session',
        accepted: false,
        streamStatus: STREAM_STATUS.STOPPED,
        notice: {
          severity: 'warning',
          message: 'No active session. Start a new agent task to continue.',
        },
      });
    } finally {
      session.dispose();
      clearRuntimeStreamStatus(streamId);
    }
  });

  it('drops a force-reopened child queue when host-neutral wake cannot resume it', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform(
        {},
        { agentResume: { tryResumeStream: async () => false } },
      ),
    );

    const session = new SessionHandle();
    const parentStreamId = 'runtime-follow-up-parent' as StreamTabId;
    const childStreamId = 'runtime-follow-up-child' as StreamTabId;
    const host = createRecordingHost();

    try {
      const handle = new AgentExecutionHandle(
        'runtime-follow-up-child-execution',
        parentStreamId,
        childStreamId,
        'test-subagent',
        'toolUse',
        host,
      );
      session.executions.track(handle);
      ToolUseFollowUpQueue.release(parentStreamId);

      const result = await requestRuntimeFollowUp({
        streamId: parentStreamId,
        text: 'child result',
        runtimeHost: host,
        session,
        wakeQueuedStream: true,
      });

      expect(result).toEqual({
        outcome: 'dropped',
        accepted: false,
        queueReason: 'children_running',
        wakeStatus: 'dropped',
        notice: {
          severity: 'warning',
          message:
            'Message dropped -- no session available to receive it. Start a new agent task to continue.',
        },
      });
      expect(ToolUseFollowUpQueue.getAll(parentStreamId)).toEqual([]);
      expect(host.emit).toHaveBeenLastCalledWith('updateQueuedFollowUps', {
        streamId: parentStreamId,
        messages: [],
      });
    } finally {
      session.dispose();
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('reports when a queued follow-up wakes the parent stream', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform(
        {},
        { agentResume: { tryResumeStream: async () => true } },
      ),
    );

    const session = new SessionHandle();
    const parentStreamId = 'runtime-follow-up-wake-parent' as StreamTabId;
    const childStreamId = 'runtime-follow-up-wake-child' as StreamTabId;
    const host = createRecordingHost();

    try {
      session.executions.track(
        new AgentExecutionHandle(
          'runtime-follow-up-wake-child-execution',
          parentStreamId,
          childStreamId,
          'test-subagent',
          'toolUse',
          host,
        ),
      );

      const result = await requestRuntimeFollowUp({
        streamId: parentStreamId,
        text: 'child result',
        runtimeHost: host,
        session,
        wakeQueuedStream: true,
      });

      expect(result).toEqual({
        outcome: 'queued',
        accepted: true,
        queueReason: 'children_running',
        wakeStatus: 'resumed',
      });
      expect(ToolUseFollowUpQueue.getAll(parentStreamId)).toEqual([
        'child result',
      ]);
    } finally {
      session.dispose();
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });
});
