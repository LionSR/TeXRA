/**
 * Stream lifecycle: the session-fact subscriptions the backend owns, and what
 * deleting one stream or every stream does to selection, rendered state, and
 * the host lifecycle callbacks.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@tools/goal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tools/goal')>();
  return {
    ...actual,
    // ProgressBackend tests replace cleanup methods to exercise failures.
    // The GoalStore suite separately tests the canonical frozen singleton.
    GoalStore: { ...actual.GoalStore },
  };
});

import { ProgressBackend } from '@controllers/progressView/backend/ProgressBackend';
import * as logger from '@logger/logUtils';
import {
  AgentCategory,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { FakeStateStore } from '@test/support/FakePlatform';
import {
  createApprovalOptions,
  createLifecycleOptions,
} from '@test/support/ProgressControllerHarnesses';
import { createTestSession } from '@test/support/sessionTestUtils';
import { GoalStore } from '@tools/goal';

import {
  createIsolatedRecordingBackend,
  createRecordingBackend,
  emitActiveStream,
  emitRunConfig,
  toolUseConfig,
  track,
} from './progressBackendHarness';

type RecordingTarget = ReturnType<typeof createIsolatedRecordingBackend>;

function emitRemoveStream(
  target: RecordingTarget,
  streamId: StreamTabId,
): void {
  target.session.events.emit({
    scope: 'session',
    event: { type: 'removeStream', payload: { streamId } },
  });
}

function stubClearAll(
  backend: RecordingTarget['backend'],
  active: Set<StreamTabId> = new Set(),
): void {
  vi.spyOn(backend.state, 'clearAll').mockResolvedValue({
    active,
    failed: new Set(),
  });
}

describe('ProgressBackend', () => {
  it('projects every approval bypass kind through one backend port', () => {
    const { backend, messages } = createRecordingBackend();
    const kinds = ['bash', 'toolEdit', 'superYolo'] as const;

    for (const kind of kinds) {
      backend.setApprovalBypassState({
        streamId: 'stream:bypass',
        kind,
        bypassActive: true,
      });
    }

    expect(messages).toEqual(
      kinds.map((kind) => ({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_BYPASS,
        stream: 'stream:bypass',
        type: kind,
        bypassActive: true,
      })),
    );
  });

  it('handles session facts through its local subscription', () => {
    const target = createIsolatedRecordingBackend();
    const { backend } = target;
    backend.setupEventListeners();
    const streamId = 'desktop-local-stream' as StreamTabId;

    emitActiveStream(target, {
      streamId,
      agentCategory: AgentCategory.Workflow,
    });

    expect(backend.state.activeStream).toBe(streamId);
    expect(backend.state.streamLogs.has(streamId)).toBe(true);
  });

  it('attaches snapshot events before run-fact projection', () => {
    const target = createIsolatedRecordingBackend();
    const { backend } = target;
    backend.setupEventListeners();
    const streamId = 'snapshot-before-projection' as StreamTabId;

    emitRunConfig(
      target,
      streamId,
      'c40001' as ExecutionId,
      toolUseConfig('search', 'deepseekproT'),
    );

    // The config snapshot is projected; identity stays pending until a
    // `run.start` supplies it (setRunConfig no longer synthesizes one).
    expect(backend.state.getStreamMetadata(streamId).config).toMatchObject({
      model: 'deepseekproT',
    });
    expect(backend.state.getStreamMetadata(streamId).identity).toBeUndefined();
  });

  it('clears an empty active-stream selection through the shared fact path', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages } = target;
    backend.setupEventListeners();

    backend.state.switchActiveStream('previous-stream');
    emitActiveStream(target, { streamId: null });

    await vi.waitFor(() => expect(backend.state.activeStream).toBe(''));
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: '',
    });
  });

  it('projects goal-state changes through the shared fact path', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages, session } = target;
    backend.setupEventListeners();
    const stream = 'goal-projection' as StreamTabId;

    try {
      await GoalStore.start(stream, 'Complete the proof');
      session.events.emit({
        scope: 'session',
        event: { type: 'goalStateChanged', payload: { streamId: stream } },
      });

      await vi.waitFor(() =>
        expect(messages).toContainEqual({
          command: PROGRESS_VIEW_COMMANDS.GOAL_ACTIVE_UPDATED,
          stream,
          active: true,
          status: 'active',
          objective: 'Complete the proof',
        }),
      );
    } finally {
      await GoalStore.forget(stream);
    }
  });

  it('routes removeStream session facts through the shared lifecycle delete path', async () => {
    const deletedStreams: StreamTabId[] = [];
    const target = createIsolatedRecordingBackend(
      createTestSession(),
      createLifecycleOptions({
        cleanupDeletedStream: (stream) => deletedStreams.push(stream),
      }),
    );
    const { backend } = target;
    backend.setupEventListeners();
    const streamId = 'desktop-child-stream' as StreamTabId;

    try {
      backend.state.streamLogs.ensureStream(streamId);
      backend.state.getOrCreateStreamState(streamId, AgentCategory.ToolUse);

      emitRemoveStream(target, streamId);

      await vi.waitFor(() => expect(deletedStreams).toEqual([streamId]));
      expect(backend.state.streamLogs.has(streamId)).toBe(false);
      expect(backend.state.getStreamState(streamId)).toBeUndefined();
    } finally {
      await backend.state.clearAll();
    }
  });

  it('handles removeStream session facts before backend load', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend } = target;
    const clearStream = vi.spyOn(backend.state, 'clearStream');
    backend.setupEventListeners();
    const streamId = 'preload-child-stream' as StreamTabId;

    emitRemoveStream(target, streamId);

    await vi.waitFor(() => expect(clearStream).toHaveBeenCalledWith(streamId));
  });

  it('refuses reserved stream identifiers before durable cleanup', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const clearStream = vi.spyOn(backend.state, 'clearStream');

    await backend.deleteStream('' as StreamTabId);
    await backend.deleteStream('.' as StreamTabId);
    await backend.deleteStream('..' as StreamTabId);

    expect(clearStream).not.toHaveBeenCalled();
  });

  it('clears retry UI when stopping without deleting', async () => {
    const { backend, lifecycle } = createIsolatedRecordingBackend();
    const stream = 'standalone-stop' as StreamTabId;

    await backend.stopStream(stream);

    expect(lifecycle.stopStream).toHaveBeenCalledWith(stream, {
      clearRetryRequest: true,
    });
    expect(lifecycle.cleanupDeletedStream).not.toHaveBeenCalled();
  });

  it('waits for a terminal child lease after its handle is untracked', async () => {
    const { backend, session } = createIsolatedRecordingBackend();
    const stream = 'completed-background-bash' as StreamTabId;
    let releaseLease!: () => void;
    const leaseReleased = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    const waitForRelease = vi
      .spyOn(backend.state.stores, 'waitForOwnedExecutionRelease')
      .mockReturnValue(leaseReleased);
    const clearStream = vi.spyOn(backend.state, 'clearStream');

    try {
      backend.state.streamLogs.ensureStream(stream);
      expect(session.executions.getAgentHandleByStream(stream)).toBeUndefined();

      const deletion = backend.deleteStream(stream);
      await vi.waitFor(() =>
        expect(waitForRelease).toHaveBeenCalledWith(stream),
      );
      expect(clearStream).not.toHaveBeenCalled();

      releaseLease();
      await deletion;

      expect(clearStream).toHaveBeenCalledWith(stream);
      expect(backend.state.streamLogs.has(stream)).toBe(false);
    } finally {
      releaseLease();
    }
  });

  it('deletes an active stream and activates the next visible stream', async () => {
    const { backend, lifecycle, messages } = createIsolatedRecordingBackend();
    const first = 'first-visible' as StreamTabId;
    const second = 'second-visible' as StreamTabId;

    backend.state.streamLogs.ensureStream(first);
    backend.state.streamLogs.ensureStream(second);
    backend.state.switchActiveStream(second);

    await backend.deleteStream(second);

    expect(lifecycle.cleanupDeletedStream).toHaveBeenCalledWith(second);
    expect(backend.state.activeStream).toBe(first);
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream: second,
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: first,
    });
  });

  it('keeps the fallback selected when its transcript fails to load', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages, reportTranscriptLoadError } = target;
    const fallback = 'fallback-stream' as StreamTabId;
    const active = 'active-stream' as StreamTabId;
    const loadError = new Error('transcript unavailable');

    backend.state.streamLogs.ensureStream(fallback);
    backend.state.streamLogs.ensureStream(active);
    backend.state.switchActiveStream(active);
    vi.spyOn(backend.state.streamLogs, 'ensureLoaded').mockRejectedValueOnce(
      loadError,
    );

    await backend.deleteStream(active);

    expect(backend.state.activeStream).toBe(fallback);
    expect(reportTranscriptLoadError).toHaveBeenCalledWith(loadError, fallback);
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: fallback,
    });
  });

  it('reports the stream whose full refresh fails after selection changes', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, reportTranscriptLoadError } = target;
    const refreshing = 'refreshing-stream' as StreamTabId;
    const selected = 'new-selection' as StreamTabId;
    const loadError = new Error('read failed');
    let rejectRefresh!: (error: Error) => void;

    backend.state.streamLogs.ensureStream(refreshing);
    backend.state.streamLogs.ensureStream(selected);
    backend.state.switchActiveStream(refreshing);
    vi.spyOn(backend.state.streamLogs, 'ensureLoaded').mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );

    const refresh = backend.syncRenderedStreams({ syncActiveStream: true });
    backend.state.switchActiveStream(selected);
    rejectRefresh(loadError);
    await refresh;

    expect(reportTranscriptLoadError).toHaveBeenCalledWith(
      loadError,
      refreshing,
    );
  });

  it('releases the tab left behind when deletion rotates the selection', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, lifecycle } = target;
    const older = 'older-stream' as StreamTabId;
    const active = 'active-stream' as StreamTabId;
    const requestEviction = vi.spyOn(
      backend.state.streamLogs,
      'requestEviction',
    );

    backend.state.streamLogs.ensureStream(older);
    backend.state.streamLogs.ensureStream(active);
    backend.state.switchActiveStream(active);
    requestEviction.mockClear();

    await backend.deleteStream(older);

    // `active` stays selected, so nothing is released; deleting the
    // non-selected tab only refreshes the list.
    expect(backend.state.activeStream).toBe(active);
    expect(requestEviction).not.toHaveBeenCalled();
    expect(lifecycle.rebuildRenderedStreams).toHaveBeenCalledWith({
      syncActiveStream: false,
    });
  });

  it('clears selection when deleting the only stream', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, lifecycle } = target;
    const only = 'only-stream' as StreamTabId;

    backend.state.streamLogs.ensureStream(only);
    backend.state.switchActiveStream(only);
    const activateStream = vi.spyOn(backend, 'activateStream');

    await backend.deleteStream(only);

    expect(backend.state.activeStream).toBe('');
    expect(activateStream).not.toHaveBeenCalled();
    // No stream was activated, so only the stream list is resent.
    expect(lifecycle.rebuildRenderedStreams).toHaveBeenCalledWith({
      syncActiveStream: false,
    });
  });

  it('preserves a stream switch during active-stream deletion', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages } = target;
    const active = 'active-stream' as StreamTabId;
    const fallback = 'fallback-stream' as StreamTabId;
    const selected = 'selected-during-delete' as StreamTabId;
    const clearStream = backend.state.clearStream.bind(backend.state);
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    vi.spyOn(backend.state, 'clearStream').mockImplementation(
      async (stream) => {
        await clearGate;
        return clearStream(stream);
      },
    );

    for (const stream of [active, fallback, selected]) {
      backend.state.streamLogs.ensureStream(stream);
    }
    backend.state.updateStreamMetadata(selected, {
      agentCategory: AgentCategory.ToolUse,
    });
    backend.state.getOrCreateStreamState(selected, AgentCategory.ToolUse);
    backend.state.switchActiveStream(active);

    const deletion = backend.deleteStream(active);
    backend.state.switchActiveStream(selected);
    releaseClear();
    await deletion;

    expect(backend.state.activeStream).toBe(selected);
    expect(messages).toContainEqual(
      expect.objectContaining({
        command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
        action: 'render',
        stream: selected,
        activeState: expect.any(Object),
      }),
    );
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: selected,
    });
  });

  it('cleans every stream and emits one bulk deletion', async () => {
    const { backend, lifecycle, messages } = createIsolatedRecordingBackend();
    const first = 'bulk-first' as StreamTabId;
    const second = 'bulk-second' as StreamTabId;
    backend.state.streamLogs.ensureStream(first);
    backend.state.streamLogs.ensureStream(second);
    stubClearAll(backend);

    await backend.deleteAllStreams();

    expect(lifecycle.cleanupDeletedStream).toHaveBeenCalledWith(first);
    expect(lifecycle.cleanupDeletedStream).toHaveBeenCalledWith(second);
    expect(lifecycle.cleanupDeletedStreams).toHaveBeenCalledWith({
      allDeleted: true,
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.DELETE_ALL,
    });
    expect(lifecycle.rebuildRenderedStreams).toHaveBeenCalledWith({
      syncActiveStream: false,
    });
    expect(lifecycle.notifyDeletionRetained).not.toHaveBeenCalled();
  });

  it('stops locally owned streams before bulk cleanup', async () => {
    const { backend, lifecycle, session } = createIsolatedRecordingBackend();
    const first = 'owned-first' as StreamTabId;
    const second = 'owned-second' as StreamTabId;
    for (const stream of [first, second]) {
      backend.state.streamLogs.ensureStream(stream);
      session.status.transition(
        stream,
        STREAM_PHASE.RUNNING,
        STREAM_TRANSITION_CAUSE.LIFECYCLE,
      );
    }
    vi.spyOn(session.executions, 'getAgentHandleByStream').mockReturnValue(
      {} as never,
    );
    const waitForRelease = vi
      .spyOn(backend.state.stores, 'waitForOwnedExecutionRelease')
      .mockResolvedValue(undefined);
    stubClearAll(backend);

    await backend.deleteAllStreams();

    expect(lifecycle.stopStream).toHaveBeenCalledWith(first);
    expect(lifecycle.stopStream).toHaveBeenCalledWith(second);
    expect(waitForRelease).toHaveBeenCalledWith(first);
    expect(waitForRelease).toHaveBeenCalledWith(second);
  });

  it('aborts bulk cleanup when stopping an owned stream fails', async () => {
    const stopError = new Error('stop failed');
    const lifecycle = createLifecycleOptions({
      stopStream: vi.fn().mockRejectedValue(stopError),
    });
    const { backend, session } = createIsolatedRecordingBackend(
      createTestSession(),
      lifecycle,
    );
    const stream = 'owned-stop-failure' as StreamTabId;
    backend.state.streamLogs.ensureStream(stream);
    session.status.transition(
      stream,
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    vi.spyOn(session.executions, 'getAgentHandleByStream').mockReturnValue(
      {} as never,
    );
    const waitForRelease = vi.spyOn(
      backend.state.stores,
      'waitForOwnedExecutionRelease',
    );
    const clearAll = vi.spyOn(backend.state, 'clearAll');

    await expect(backend.deleteAllStreams()).rejects.toBe(stopError);

    expect(lifecycle.stopStream).toHaveBeenCalledWith(stream);
    expect(waitForRelease).not.toHaveBeenCalled();
    expect(clearAll).not.toHaveBeenCalled();
    expect(lifecycle.cleanupDeletedStream).not.toHaveBeenCalled();
    expect(lifecycle.cleanupDeletedStreams).not.toHaveBeenCalled();
  });

  it('retains protected streams during bulk cleanup', async () => {
    const { backend, lifecycle, messages } = createIsolatedRecordingBackend();
    const deleted = 'bulk-deleted' as StreamTabId;
    const retained = 'bulk-retained' as StreamTabId;
    backend.state.streamLogs.ensureStream(deleted);
    backend.state.streamLogs.ensureStream(retained);
    stubClearAll(backend, new Set([retained]));

    await backend.deleteAllStreams();

    expect(lifecycle.cleanupDeletedStream).toHaveBeenCalledWith(deleted);
    expect(lifecycle.cleanupDeletedStream).not.toHaveBeenCalledWith(retained);
    expect(lifecycle.cleanupDeletedStreams).toHaveBeenCalledWith({
      allDeleted: false,
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream: deleted,
    });
    expect(messages).not.toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.DELETE_ALL,
    });
    expect(lifecycle.rebuildRenderedStreams).toHaveBeenCalledWith({
      syncActiveStream: true,
    });
    expect(lifecycle.notifyDeletionRetained).toHaveBeenCalledWith(1, 0);
  });

  it('retains rendered state when durable stream cleanup fails', async () => {
    const session = track(createTestSession());
    const lifecycle = createLifecycleOptions();
    const backend = track(
      new ProgressBackend({
        storage: new FakeStateStore(),
        session,
        sendMessage: vi.fn(),
        hasTarget: () => true,
        reportTranscriptLoadError: vi.fn(),
        approvals: createApprovalOptions(),
        lifecycle,
      }),
    );
    const stream = 'retained-stream' as StreamTabId;
    backend.state.streamLogs.ensureStream(stream);
    vi.spyOn(backend.state, 'clearStream').mockResolvedValueOnce('failed');

    await backend.deleteStream(stream);

    expect(lifecycle.cleanupDeletedStream).not.toHaveBeenCalled();
    expect(lifecycle.rebuildRenderedStreams).toHaveBeenCalledWith({
      syncActiveStream: true,
    });
    expect(lifecycle.notifyDeletionRetained).toHaveBeenCalledWith(0, 1);
  });

  it('uses the injected target predicate before sending messages', () => {
    const sent = vi.fn(() => true);
    let hasTarget = false;
    const backend = track(
      new ProgressBackend({
        storage: new FakeStateStore(),
        sendMessage: sent,
        hasTarget: () => hasTarget,
        reportTranscriptLoadError: vi.fn(),
        approvals: createApprovalOptions(),
        lifecycle: createLifecycleOptions(),
      }),
    );

    backend.webviewUpdater.updateTodos('alpha' as StreamTabId, []);
    expect(sent).not.toHaveBeenCalled();

    hasTarget = true;
    backend.webviewUpdater.updateTodos('alpha' as StreamTabId, []);
    expect(sent).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_TODOS,
      stream: 'alpha',
      todos: [],
    });
  });

  it('reports contained updater transport failures at debug', async () => {
    const sent = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockImplementationOnce(() => {
        throw new Error('closed transport');
      })
      .mockRejectedValueOnce(new Error('closed transport'));
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    const backend = track(
      new ProgressBackend({
        storage: new FakeStateStore(),
        sendMessage: sent,
        hasTarget: () => true,
        reportTranscriptLoadError: vi.fn(),
        approvals: createApprovalOptions(),
        lifecycle: createLifecycleOptions(),
      }),
    );

    expect(() =>
      backend.webviewUpdater.updateTodos('alpha' as StreamTabId, []),
    ).not.toThrow();
    backend.webviewUpdater.updateTodos('alpha' as StreamTabId, []);

    expect(sent).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(2));
    expect(debug).toHaveBeenCalledWith(
      'ProgressBackend',
      'Failed to deliver message to webview',
      expect.objectContaining({
        data: expect.objectContaining({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_TODOS,
        }),
      }),
    );
  });

  it('stops projecting session facts once disposed', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages } = target;
    backend.setupEventListeners();
    const stream = 'disposed-projection' as StreamTabId;

    backend.dispose();
    messages.length = 0;

    emitActiveStream(target, {
      streamId: stream,
      agentCategory: AgentCategory.Workflow,
    });
    await Promise.resolve();

    expect(backend.state.activeStream).toBe('');
    expect(messages).toEqual([]);
  });

  it('attaches nothing when listeners are set up after disposal', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages } = target;
    const stream = 'late-attach-projection' as StreamTabId;

    backend.dispose();
    backend.setupEventListeners();

    emitActiveStream(target, {
      streamId: stream,
      agentCategory: AgentCategory.Workflow,
    });
    await Promise.resolve();

    expect(backend.state.activeStream).toBe('');
    expect(messages).toEqual([]);
  });
});
