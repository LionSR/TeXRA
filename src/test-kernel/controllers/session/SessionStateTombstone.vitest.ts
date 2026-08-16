// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { DeleteStreamResult } from '@agent/storage';
import { SessionFactApplier } from '@controllers/session/SessionFactApplier';
import type { SessionRendererPort } from '@controllers/session/SessionRendererPort';
import { SessionState } from '@controllers/session/SessionState';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A renderer mock with every notification recorded but no host policy. */
function createRendererMock(): SessionRendererPort {
  return {
    isAvailable: () => true,
    dispose: vi.fn(),
    onStreamMetadataChanged: vi.fn(),
    onStreamStatusChanged: vi.fn(),
    onActiveStreamChanged: vi.fn(),
    onStreamDescriptionChanged: vi.fn(),
    onParentStreamChanged: vi.fn(),
    onConversationProgressChanged: vi.fn(),
    onStageChanged: vi.fn(),
    onBadgesChanged: vi.fn(),
    onFilesChanged: vi.fn(),
    onMissingOutputsChanged: vi.fn(),
    onCompileFailuresChanged: vi.fn(),
    onRunUsageChanged: vi.fn(),
    onTodosChanged: vi.fn(),
    onPlanChanged: vi.fn(),
    onQueuedFollowUpsChanged: vi.fn(),
    onInquiryThreadUpdated: vi.fn(),
    onGoalActiveChanged: vi.fn(),
    onGoalPaused: vi.fn(),
    clearPendingConversationProgress: vi.fn(),
    syncStreamContent: vi.fn(),
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An applier whose host delete resolves through a controllable queue. */
function createApplier(): {
  readonly state: SessionState;
  readonly applier: SessionFactApplier;
  readonly deletions: Array<Deferred<DeleteStreamResult | undefined>>;
} {
  const state = new SessionState(createTestSession());
  const deletions: Array<Deferred<DeleteStreamResult | undefined>> = [];
  const applier = new SessionFactApplier(state, createRendererMock(), {
    deleteStream: () => {
      const pending = deferred<DeleteStreamResult | undefined>();
      deletions.push(pending);
      return pending.promise;
    },
  });
  return { state, applier, deletions };
}

describe('SessionState tombstone and incarnation fences', () => {
  it('retires only the tombstone owned by the superseded deletion', async () => {
    const { state, applier, deletions } = createApplier();
    const stream = 'workflow#run1' as StreamTabId;
    const retireSpy = vi.spyOn(state, 'retireStreamTombstone');

    // Deletion A captures incarnation 0.
    applier.handleSessionFact({
      type: 'removeStream',
      payload: { streamId: stream },
    });
    expect(deletions).toHaveLength(1);
    expect(state.isStreamRemoved(stream)).toBe(true);

    // A fresh workflow attachment re-claims the identity, then deletion B
    // installs a new barrier for incarnation 1 before A's promise resolves.
    state.claimStreamIdentity(stream);
    applier.handleSessionFact({
      type: 'removeStream',
      payload: { streamId: stream },
    });
    expect(deletions).toHaveLength(2);
    expect(state.isStreamRemoved(stream)).toBe(true);

    // A resolves superseded: it retires with its own incarnation and must not
    // remove B's barrier.
    deletions[0].resolve('superseded');
    await vi.waitFor(() => expect(retireSpy).toHaveBeenCalledWith(stream, 0));
    expect(state.isStreamRemoved(stream)).toBe(true);

    // Only B's retained outcome retires the barrier B owns.
    deletions[1].resolve('active');
    await vi.waitFor(() => expect(retireSpy).toHaveBeenCalledWith(stream, 1));
    expect(state.isStreamRemoved(stream)).toBe(false);
  });

  it('tombstones ephemeral-only identities on clearAll without touching retained streams', async () => {
    const state = new SessionState(createTestSession());
    const ephemeral = 'ephemeral-running' as StreamTabId;
    const retained = 'retained-durable' as StreamTabId;

    state.getOrCreateStreamState(ephemeral, AgentCategory.ToolUse);
    state.streamLogs.ensureStream(retained);
    vi.spyOn(state.stores, 'deleteAll').mockResolvedValue({
      active: new Set([retained]),
      failed: new Set(),
      deleted: new Set(),
    });

    await state.clearAll();

    expect(state.isStreamRemoved(ephemeral)).toBe(true);
    expect(state.getStreamState(ephemeral)).toBeUndefined();
    expect(state.isStreamRemoved(retained)).toBe(false);
    expect(state.streamLogs.has(retained)).toBe(true);
  });

  it('replays facts buffered during a retained deletion', async () => {
    const { state, applier, deletions } = createApplier();
    const stream = 'child-stream' as StreamTabId;
    state.getOrCreateStreamState(stream, AgentCategory.ToolUse);

    applier.handleSessionFact({
      type: 'removeStream',
      payload: { streamId: stream },
    });

    // Both a session fact and a run fact arrive while the deletion is in
    // flight; they are refused (buffered), not applied.
    const admitted = applier.handleSessionFact({
      type: 'updateStreamDescription',
      payload: { streamId: stream, description: 'retained description' },
    });
    expect(admitted).toBe(false);
    applier.handleRunFact(stream, {
      type: 'conversation.progress',
      progress: { toolCallCount: 7 },
    });

    expect(state.getStreamMetadata(stream).description).toBeUndefined();
    expect(
      state.getStreamState(stream)?.conversationProgress.toolCallCount,
    ).toBe(0);

    // The deletion is retained: the provisional barrier retires and the
    // buffered facts are replayed so the live stream is not stuck stale.
    deletions[0].resolve('failed');
    await vi.waitFor(() =>
      expect(state.getStreamMetadata(stream).description).toBe(
        'retained description',
      ),
    );
    expect(
      state.getStreamState(stream)?.conversationProgress.toolCallCount,
    ).toBe(7);
    expect(state.isStreamRemoved(stream)).toBe(false);
  });
});
