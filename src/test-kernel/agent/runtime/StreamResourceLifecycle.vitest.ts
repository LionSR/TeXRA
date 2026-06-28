import { describe, expect, it, vi } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import {
  releaseRuntimeDeletedStream,
  releaseRuntimeDeletedStreams,
} from '@agent/runtime/streamResourceLifecycle';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';
import { GoalStore } from '@tools/goal';

function createRecordingHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

describe('runtime stream resource lifecycle', () => {
  it('uses the active run session when no session is passed', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform());

    const runSession = new SessionHandle();
    const streamId = 'stream-resource-current-session' as StreamTabId;
    const host = createRecordingHost();
    const cleanupRunSession = vi.spyOn(
      runSession.coordinators,
      'cleanupRequestsForStream',
    );
    const cleanupDefaultSession = vi.spyOn(
      defaultSession().coordinators,
      'cleanupRequestsForStream',
    );

    try {
      await withRunContext(
        createRunContext({ runtimeHost: host, session: runSession }),
        () =>
          releaseRuntimeDeletedStream({
            streamId,
          }),
      );

      expect(cleanupRunSession).toHaveBeenCalledWith(streamId);
      expect(cleanupDefaultSession).not.toHaveBeenCalledWith(streamId);
    } finally {
      cleanupDefaultSession.mockRestore();
      runSession.dispose();
      ToolUseFollowUpQueue.release(streamId);
    }
  });

  it('releases runtime-owned resources for a deleted stream', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform());

    const session = new SessionHandle();
    const streamId = 'stream-resource-lifecycle' as StreamTabId;
    const host = createRecordingHost();
    const cleanupRequestsForStream = vi.spyOn(
      session.coordinators,
      'cleanupRequestsForStream',
    );
    ToolUseFollowUpQueue.acquire(streamId).enqueue({
      text: 'queued follow-up',
    });
    await GoalStore.start(streamId, 'Finish the deleted stream cleanup.');

    try {
      await releaseRuntimeDeletedStream({
        streamId,
        session,
        runtimeHost: host,
        publishQueueProjection: true,
      });

      expect(ToolUseFollowUpQueue.getAll(streamId)).toEqual([]);
      expect(GoalStore.getForStream(streamId)).toBeNull();
      expect(cleanupRequestsForStream).toHaveBeenCalledWith(streamId);
      expect(host.emit).toHaveBeenCalledWith('updateQueuedFollowUps', {
        streamId,
        messages: [],
      });
    } finally {
      session.dispose();
      ToolUseFollowUpQueue.release(streamId);
    }
  });

  it('uses session-scoped cleanup for desktop-style delete all', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform());

    const session = new SessionHandle();
    const firstStream = 'stream-resource-session-first' as StreamTabId;
    const secondStream = 'stream-resource-session-second' as StreamTabId;
    const host = createRecordingHost();
    const cleanupAllRequests = vi.spyOn(
      session.coordinators,
      'cleanupAllRequests',
    );

    ToolUseFollowUpQueue.acquire(firstStream).enqueue({ text: 'first' });
    ToolUseFollowUpQueue.acquire(secondStream).enqueue({ text: 'second' });
    await GoalStore.start(firstStream, 'Delete first stream.');
    await GoalStore.start(secondStream, 'Delete second stream.');

    try {
      await releaseRuntimeDeletedStreams({
        streamIds: [firstStream, secondStream],
        approvalScope: 'session',
        session,
        runtimeHost: host,
        publishQueueProjection: true,
      });

      expect(ToolUseFollowUpQueue.getAll(firstStream)).toEqual([]);
      expect(ToolUseFollowUpQueue.getAll(secondStream)).toEqual([]);
      expect(GoalStore.getForStream(firstStream)).toBeNull();
      expect(GoalStore.getForStream(secondStream)).toBeNull();
      expect(cleanupAllRequests).toHaveBeenCalledOnce();
      expect(host.emit).toHaveBeenCalledWith('updateQueuedFollowUps', {
        streamId: firstStream,
        messages: [],
      });
      expect(host.emit).toHaveBeenCalledWith('updateQueuedFollowUps', {
        streamId: secondStream,
        messages: [],
      });
    } finally {
      session.dispose();
      ToolUseFollowUpQueue.release(firstStream);
      ToolUseFollowUpQueue.release(secondStream);
    }
  });

  it('uses process-scoped cleanup for single-session delete all', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform());

    const session = new SessionHandle();
    const streamId = 'stream-resource-process-scope' as StreamTabId;
    const host = createRecordingHost();
    const cleanupAllRequests = vi.spyOn(
      session.coordinators,
      'cleanupAllRequests',
    );

    ToolUseFollowUpQueue.acquire(streamId).enqueue({ text: 'queued' });
    await GoalStore.start(streamId, 'Delete process stream.');

    try {
      await releaseRuntimeDeletedStreams({
        streamIds: [streamId],
        approvalScope: 'process',
        session,
        runtimeHost: host,
        publishQueueProjection: true,
      });

      expect(ToolUseFollowUpQueue.getAll(streamId)).toEqual([]);
      expect(GoalStore.getForStream(streamId)).toBeNull();
      expect(cleanupAllRequests).toHaveBeenCalledOnce();
      expect(host.emit).toHaveBeenCalledWith('updateQueuedFollowUps', {
        streamId,
        messages: [],
      });
    } finally {
      session.dispose();
      ToolUseFollowUpQueue.release(streamId);
    }
  });
});
