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

/**
 * Stalls `clearStream` until the returned release is called, so a test can
 * interleave a selection change while a stream deletion is in flight.
 */
function gateClearStream(backend: RecordingTarget['backend']): () => void {
  const clearStream = backend.state.clearStream.bind(backend.state);
  let releaseClear!: () => void;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  vi.spyOn(backend.state, 'clearStream').mockImplementation(async (stream) => {
    await clearGate;
    return clearStream(stream);
  });
  return releaseClear;
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

  it('handles session facts through its local subscription', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend } = target;
    backend.setupEventListeners();
    const streamId = 'desktop-local-stream' as StreamTabId;

    emitActiveStream(target, {
      streamId,
      agentCategory: AgentCategory.Workflow,
    });

    await vi.waitFor(() =>
      expect(backend.presentation.activeStream).toBe(streamId),
    );
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

    backend.presentation.select('previous-stream');
    emitActiveStream(target, { streamId: null });

    await vi.waitFor(() => expect(backend.presentation.activeStream).toBe(''));
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: '',
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.RELEASE_STREAM_CONTENT,
      stream: 'previous-stream',
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
    backend.presentation.select(second);

    await backend.deleteStream(second);

    expect(lifecycle.cleanupDeletedStream).toHaveBeenCalledWith(second);
    expect(backend.presentation.activeStream).toBe(first);
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream: second,
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: first,
    });
  });

  it('does not select a fallback whose transcript fails to load', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages, reportTranscriptLoadError } = target;
    const fallback = 'fallback-stream' as StreamTabId;
    const active = 'active-stream' as StreamTabId;
    const loadError = new Error('transcript unavailable');

    backend.state.streamLogs.ensureStream(fallback);
    backend.state.streamLogs.ensureStream(active);
    backend.presentation.select(active);
    vi.spyOn(backend.state.streamLogs, 'ensureLoaded').mockRejectedValueOnce(
      loadError,
    );

    await backend.deleteStream(active);

    expect(backend.presentation.activeStream).toBe('');
    expect(reportTranscriptLoadError).toHaveBeenCalledWith(loadError, fallback);
    expect(messages).not.toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: fallback,
    });
  });

  it('waits for both active-stream hydrations before syncing partial state', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages, reportTranscriptLoadError } = target;
    const stream = 'hydration-race' as StreamTabId;
    const sidecarError = new Error('sidecar unavailable');
    let rejectSidecarLoad!: () => void;

    backend.state.streamLogs.ensureStream(stream);
    vi.spyOn(backend.state.snapshots, 'preload').mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSidecarLoad = () => reject(sidecarError);
        }),
    );

    const activation = backend.activateStream(stream);
    await Promise.resolve();
    expect(reportTranscriptLoadError).not.toHaveBeenCalled();

    rejectSidecarLoad();
    await activation;

    expect(reportTranscriptLoadError).toHaveBeenCalledWith(
      sidecarError,
      stream,
    );
    expect(messages).not.toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: stream,
    });
  });

  it('selects the newest available stream on an authoritative fresh sync', async () => {
    const { backend, messages } = createIsolatedRecordingBackend();
    const stream = 'fresh-sync-stream' as StreamTabId;

    backend.state.streamLogs.ensureStream(stream);
    await backend.syncRenderedStreams({ syncActiveStream: true });

    expect(backend.presentation.activeStream).toBe(stream);
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: stream,
    });
  });

  it('does not commit a stream deleted while its hydration is pending', async () => {
    const { backend, messages } = createIsolatedRecordingBackend();
    const stream = 'deleted-during-hydration' as StreamTabId;
    let finishPreload!: () => void;

    backend.state.streamLogs.ensureStream(stream);
    vi.spyOn(backend.state.snapshots, 'preload').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPreload = resolve;
        }),
    );

    const activation = backend.activateStream(stream, 'deleted-request');
    await vi.waitFor(() => expect(finishPreload).toBeTypeOf('function'));
    await backend.deleteStream(stream);
    finishPreload();
    await activation;

    expect(backend.presentation.activeStream).toBe('');
    expect(messages).not.toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: stream,
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SETTLE_STREAM_SELECTION,
      requestId: 'deleted-request',
      status: 'superseded',
      activeStream: '',
    });
  });

  it('invalidates older hydration when a newer selection is rejected', async () => {
    const { backend, messages } = createIsolatedRecordingBackend();
    const confirmed = 'confirmed-before-rejection' as StreamTabId;
    const older = 'older-pending-selection' as StreamTabId;
    let finishOlderPreload!: () => void;

    backend.state.streamLogs.ensureStream(confirmed);
    backend.state.streamLogs.ensureStream(older);
    backend.presentation.select(confirmed);
    vi.spyOn(backend.state.snapshots, 'preload').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishOlderPreload = resolve;
        }),
    );

    const olderActivation = backend.activateStream(older);
    await vi.waitFor(() => expect(finishOlderPreload).toBeTypeOf('function'));
    await backend.activateStream(
      'already-deleted-selection' as StreamTabId,
      'newer-rejected-request',
    );
    finishOlderPreload();
    await olderActivation;

    expect(backend.presentation.activeStream).toBe(confirmed);
    expect(messages).not.toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: older,
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SETTLE_STREAM_SELECTION,
      requestId: 'newer-rejected-request',
      status: 'rejected',
      activeStream: confirmed,
    });
  });

  it('lets explicit deselection supersede older hydration', async () => {
    const { backend, messages } = createIsolatedRecordingBackend();
    const stream = 'pending-before-deselection' as StreamTabId;
    let finishPreload!: () => void;

    backend.state.streamLogs.ensureStream(stream);
    vi.spyOn(backend.state.snapshots, 'preload').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPreload = resolve;
        }),
    );

    const activation = backend.activateStream(stream);
    await vi.waitFor(() => expect(finishPreload).toBeTypeOf('function'));
    await backend.activateStream('', 'deselection-request');
    finishPreload();
    await activation;

    expect(backend.presentation.activeStream).toBe('');
    expect(messages).not.toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: stream,
    });
  });

  it('rejects a failed UI selection without changing the confirmed stream', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages, reportTranscriptLoadError } = target;
    const confirmed = 'confirmed-stream' as StreamTabId;
    const requested = 'requested-stream' as StreamTabId;
    const requestId = 'selection-request-1';
    const loadError = new Error('requested transcript unavailable');

    backend.state.streamLogs.ensureStream(confirmed);
    backend.state.streamLogs.ensureStream(requested);
    backend.presentation.select(confirmed);
    vi.spyOn(backend.state.streamLogs, 'ensureLoaded').mockRejectedValueOnce(
      loadError,
    );

    await backend.activateStream(requested, requestId);

    expect(backend.presentation.activeStream).toBe(confirmed);
    expect(reportTranscriptLoadError).toHaveBeenCalledWith(
      loadError,
      requested,
    );
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SETTLE_STREAM_SELECTION,
      requestId,
      status: 'rejected',
      activeStream: confirmed,
    });
    expect(messages).not.toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: requested,
    });
  });

  it('releases inactive frontend content only after the new selection commits', async () => {
    const { backend, messages } = createIsolatedRecordingBackend();
    const previous = 'previous-stream' as StreamTabId;
    const selected = 'selected-stream' as StreamTabId;

    backend.state.streamLogs.ensureStream(previous);
    backend.state.streamLogs.ensureStream(selected);
    await backend.activateStream(previous);
    messages.length = 0;

    await backend.activateStream(selected, 'selection-request-2');

    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: selected,
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.RELEASE_STREAM_CONTENT,
      stream: previous,
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SETTLE_STREAM_SELECTION,
      requestId: 'selection-request-2',
      status: 'accepted',
      activeStream: selected,
    });
  });

  it('ignores a stale refresh failure after a newer selection commits', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, reportTranscriptLoadError } = target;
    const refreshing = 'refreshing-stream' as StreamTabId;
    const selected = 'new-selection' as StreamTabId;
    const loadError = new Error('read failed');
    let rejectRefresh!: (error: Error) => void;

    backend.state.streamLogs.ensureStream(refreshing);
    backend.state.streamLogs.ensureStream(selected);
    backend.presentation.select(refreshing);
    vi.spyOn(backend.state.streamLogs, 'ensureLoaded').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );

    const refresh = backend.syncRenderedStreams({ syncActiveStream: true });
    await backend.activateStream(selected);
    rejectRefresh(loadError);
    await refresh;

    expect(backend.presentation.activeStream).toBe(selected);
    expect(reportTranscriptLoadError).not.toHaveBeenCalled();
  });

  it('preserves an in-flight switch across an authoritative refresh', async () => {
    const { backend, messages } = createIsolatedRecordingBackend();
    const confirmed = 'confirmed-before-refresh' as StreamTabId;
    const requested = 'pending-across-refresh' as StreamTabId;
    let finishPreload!: () => void;

    backend.state.streamLogs.ensureStream(confirmed);
    backend.state.streamLogs.ensureStream(requested);
    backend.presentation.select(confirmed);
    vi.spyOn(backend.state.snapshots, 'preload').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPreload = resolve;
        }),
    );

    const activation = backend.activateStream(requested, 'refresh-request');
    await vi.waitFor(() => expect(finishPreload).toBeTypeOf('function'));
    await backend.syncRenderedStreams({ syncActiveStream: true });
    finishPreload();
    await activation;

    expect(backend.presentation.activeStream).toBe(requested);
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: requested,
    });
  });

  it('projects the stream being hydrated without confirming it early', async () => {
    const { backend, messages } = createIsolatedRecordingBackend();
    const stream = 'fresh-projected-stream' as StreamTabId;
    backend.state.streamLogs.ensureStream(stream);
    const streamRoster = vi.spyOn(backend.projections, 'streamRoster');

    await backend.syncRenderedStreams({ syncActiveStream: true });

    expect(streamRoster).toHaveBeenCalledWith(stream, expect.any(Map));
    expect(messages).toContainEqual(
      expect.objectContaining({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
        activeStream: '',
      }),
    );
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: stream,
    });
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
    backend.presentation.select(active);
    requestEviction.mockClear();

    await backend.deleteStream(older);

    // `active` stays selected, so nothing is released; deleting the
    // non-selected tab only refreshes the list.
    expect(backend.presentation.activeStream).toBe(active);
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
    backend.presentation.select(only);
    const activateStream = vi.spyOn(backend, 'activateStream');

    await backend.deleteStream(only);

    expect(backend.presentation.activeStream).toBe('');
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
    const releaseClear = gateClearStream(backend);

    for (const stream of [active, fallback, selected]) {
      backend.state.streamLogs.ensureStream(stream);
    }
    backend.state.updateStreamMetadata(selected, {
      agentCategory: AgentCategory.ToolUse,
    });
    backend.state.getOrCreateStreamState(selected, AgentCategory.ToolUse);
    backend.presentation.select(active);

    const deletion = backend.deleteStream(active);
    backend.presentation.select(selected);
    releaseClear();
    await deletion;

    expect(backend.presentation.activeStream).toBe(selected);
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

  it('recovers when an inactive stream becomes selected during deletion', async () => {
    const { backend, messages } = createIsolatedRecordingBackend();
    const fallback = 'surviving-fallback' as StreamTabId;
    const deleting = 'selected-while-deleting' as StreamTabId;
    const releaseClear = gateClearStream(backend);

    backend.state.streamLogs.ensureStream(fallback);
    backend.state.streamLogs.ensureStream(deleting);
    backend.presentation.select(fallback);

    const deletion = backend.deleteStream(deleting);
    await vi.waitFor(() =>
      expect(backend.state.clearStream).toHaveBeenCalledWith(deleting),
    );
    await backend.activateStream(deleting);
    releaseClear();
    await deletion;

    expect(backend.presentation.activeStream).toBe(fallback);
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: fallback,
    });
  });

  it('preserves explicit deselection during active-stream deletion', async () => {
    const { backend, messages } = createIsolatedRecordingBackend();
    const deleting = 'active-delete-in-progress' as StreamTabId;
    const fallback = 'launcher-must-not-replace' as StreamTabId;
    const releaseClear = gateClearStream(backend);

    backend.state.streamLogs.ensureStream(fallback);
    backend.state.streamLogs.ensureStream(deleting);
    backend.presentation.select(deleting);

    const deletion = backend.deleteStream(deleting);
    await vi.waitFor(() =>
      expect(backend.state.clearStream).toHaveBeenCalledWith(deleting),
    );
    backend.presentation.select('');
    releaseClear();
    await deletion;

    expect(backend.presentation.activeStream).toBe('');
    expect(messages).not.toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: fallback,
    });
  });

  it('preserves a newer pending switch during active-stream deletion', async () => {
    const { backend, messages } = createIsolatedRecordingBackend();
    const deleting = 'active-being-deleted' as StreamTabId;
    const fallback = 'older-roster-fallback' as StreamTabId;
    const requested = 'newer-pending-switch' as StreamTabId;
    const releaseClear = gateClearStream(backend);
    let finishRequestedPreload!: () => void;
    vi.spyOn(backend.state.snapshots, 'preload').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRequestedPreload = resolve;
        }),
    );

    for (const stream of [fallback, requested, deleting]) {
      backend.state.streamLogs.ensureStream(stream);
    }
    backend.presentation.select(deleting);

    const deletion = backend.deleteStream(deleting);
    await vi.waitFor(() =>
      expect(backend.state.clearStream).toHaveBeenCalledWith(deleting),
    );
    const activation = backend.activateStream(requested, 'pending-request');
    await vi.waitFor(() =>
      expect(finishRequestedPreload).toBeTypeOf('function'),
    );
    releaseClear();
    await deletion;
    finishRequestedPreload();
    await activation;

    expect(backend.presentation.activeStream).toBe(requested);
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: requested,
    });
    expect(messages).not.toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: fallback,
    });
  });

  it('recovers once when a pending replacement fails after deletion', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages, reportTranscriptLoadError } = target;
    const deleting = 'active-before-failed-switch' as StreamTabId;
    const requested = 'failed-pending-switch' as StreamTabId;
    const fallback = 'recovery-survivor' as StreamTabId;
    const loadError = new Error('replacement hydration failed');
    let rejectRequestedPreload!: (error: Error) => void;
    const releaseClear = gateClearStream(backend);

    for (const stream of [fallback, requested, deleting]) {
      backend.state.streamLogs.ensureStream(stream);
    }
    backend.presentation.select(deleting);
    vi.spyOn(backend.state.snapshots, 'preload').mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRequestedPreload = reject;
        }),
    );

    const deletion = backend.deleteStream(deleting);
    await vi.waitFor(() =>
      expect(backend.state.clearStream).toHaveBeenCalledWith(deleting),
    );
    const activation = backend.activateStream(requested, 'failed-request');
    await vi.waitFor(() =>
      expect(rejectRequestedPreload).toBeTypeOf('function'),
    );
    releaseClear();
    await deletion;
    rejectRequestedPreload(loadError);
    await activation;

    expect(reportTranscriptLoadError).toHaveBeenCalledWith(
      loadError,
      requested,
    );
    expect(backend.presentation.activeStream).toBe(fallback);
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: fallback,
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SETTLE_STREAM_SELECTION,
      requestId: 'failed-request',
      status: 'rejected',
      activeStream: fallback,
    });
  });

  it('preserves the newest of two switches during active-stream deletion', async () => {
    const { backend, messages } = createIsolatedRecordingBackend();
    const deleting = 'active-before-two-switches' as StreamTabId;
    const committed = 'first-concurrent-switch' as StreamTabId;
    const requested = 'second-pending-switch' as StreamTabId;
    const releaseClear = gateClearStream(backend);
    let finishRequestedPreload!: () => void;

    for (const stream of [committed, requested, deleting]) {
      backend.state.streamLogs.ensureStream(stream);
    }
    backend.presentation.select(deleting);

    const deletion = backend.deleteStream(deleting);
    await vi.waitFor(() =>
      expect(backend.state.clearStream).toHaveBeenCalledWith(deleting),
    );
    await backend.activateStream(committed);
    vi.spyOn(backend.state.snapshots, 'preload').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRequestedPreload = resolve;
        }),
    );
    const activation = backend.activateStream(requested, 'newest-request');
    await vi.waitFor(() =>
      expect(finishRequestedPreload).toBeTypeOf('function'),
    );
    releaseClear();
    await deletion;
    finishRequestedPreload();
    await activation;

    expect(backend.presentation.activeStream).toBe(requested);
    expect(
      messages.findLast(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      ),
    ).toEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: requested,
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

  it('defers a retained bulk fallback until the rebuild hydrates it', async () => {
    const { backend, lifecycle } = createIsolatedRecordingBackend();
    const first = 'retained-first' as StreamTabId;
    const second = 'retained-second' as StreamTabId;
    backend.state.streamLogs.ensureStream(first);
    backend.state.streamLogs.ensureStream(second);
    backend.presentation.select('deleted-selection');
    stubClearAll(backend, new Set([first, second]));

    await backend.deleteAllStreams();

    expect(backend.presentation.activeStream).toBe('');
    expect(lifecycle.rebuildRenderedStreams).toHaveBeenCalledWith({
      syncActiveStream: true,
    });
  });

  it('preserves a pending switch to a stream retained by bulk deletion', async () => {
    const { backend, lifecycle } = createIsolatedRecordingBackend();
    const deleting = 'bulk-active-delete' as StreamTabId;
    const requested = 'bulk-retained-request' as StreamTabId;
    let finishClear!: () => void;
    let finishPreload!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      finishClear = resolve;
    });

    backend.state.streamLogs.ensureStream(deleting);
    backend.state.streamLogs.ensureStream(requested);
    backend.presentation.select(deleting);
    vi.spyOn(backend.state, 'clearAll').mockImplementation(async () => {
      await clearGate;
      return { active: new Set([requested]), failed: new Set() };
    });

    const deletion = backend.deleteAllStreams();
    await vi.waitFor(() => expect(backend.state.clearAll).toHaveBeenCalled());
    vi.spyOn(backend.state.snapshots, 'preload').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPreload = resolve;
        }),
    );
    const activation = backend.activateStream(requested, 'bulk-request');
    await vi.waitFor(() => expect(finishPreload).toBeTypeOf('function'));
    finishClear();
    await deletion;
    finishPreload();
    await activation;

    expect(backend.presentation.activeStream).toBe(requested);
    expect(lifecycle.rebuildRenderedStreams).toHaveBeenCalledWith({
      syncActiveStream: false,
    });
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

    backend.renderer.releaseStreamContent('alpha' as StreamTabId);
    expect(sent).not.toHaveBeenCalled();

    hasTarget = true;
    backend.renderer.releaseStreamContent('alpha' as StreamTabId);
    expect(sent).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.RELEASE_STREAM_CONTENT,
      stream: 'alpha',
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
      backend.renderer.releaseStreamContent('alpha' as StreamTabId),
    ).not.toThrow();
    backend.renderer.releaseStreamContent('alpha' as StreamTabId);

    expect(sent).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(2));
    expect(debug).toHaveBeenCalledWith(
      'ProgressBackend',
      'Failed to deliver message to webview',
      expect.objectContaining({
        data: expect.objectContaining({
          command: PROGRESS_VIEW_COMMANDS.RELEASE_STREAM_CONTENT,
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

    expect(backend.presentation.activeStream).toBe('');
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

    expect(backend.presentation.activeStream).toBe('');
    expect(messages).toEqual([]);
  });
});
