// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  getExecutionStore,
  SessionStores,
  type DeleteExecutionOptions,
} from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import * as logUtils from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { snapshotFacts } from '@test/support/storeTestDrivers';
import { releaseStreamResources } from '@tools/approval';
import { StreamLogStore, StreamSnapshotStore } from '@transcript';

/** Records the stream's execution ownership through the sidecar FK. */
function ownExecution(
  snapshots: StreamSnapshotStore,
  stream: StreamTabId,
  executionId: ExecutionId,
): void {
  snapshotFacts(snapshots).setRunConfig(
    stream,
    AgentConfigSchema.parse({
      agent: 'chat',
      model: 'deepseekT',
      agentCategory: 'toolUse',
    }),
    executionId,
  );
}

function deletionSpy() {
  return vi.fn(
    async (executionId: ExecutionId, options?: DeleteExecutionOptions) => {
      await options?.beforeDelete?.();
      return { status: 'deleted' as const, executionId };
    },
  );
}

describe('SessionStores deletion coordination', () => {
  it('tracks lease-gated deletion without blocking its artifact flush', async () => {
    const session = createTestSession();
    const stream = 'lease-gated-delete' as StreamTabId;
    session.transcripts.ensureStream(stream);
    const snapshots = new StreamSnapshotStore();
    const stores = new SessionStores({
      streamLogs: session.transcripts,
      snapshots,
    });
    let releaseLease!: () => void;
    const leaseReleased = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    vi.spyOn(stores, 'waitForOwnedExecutionRelease').mockReturnValue(
      leaseReleased,
    );
    const flush = vi.spyOn(snapshots, 'flush');

    try {
      const deletion = stores.deleteStreamAfterOwnedExecutionRelease(stream);
      const drain = stores.waitForPendingStreamDeletions();
      let drainFinished = false;
      void drain.then(() => {
        drainFinished = true;
      });

      await stores.flushSnapshotsAfterStartedDeletions();
      expect(flush).toHaveBeenCalledOnce();
      expect(drainFinished).toBe(false);
      expect(session.transcripts.has(stream)).toBe(true);

      releaseLease();
      await expect(deletion).resolves.toBe('deleted');
      await drain;
      expect(session.transcripts.has(stream)).toBe(false);
    } finally {
      releaseLease();
      session.dispose();
    }
  });

  it('releases one canonical stream once when single and bulk deletion overlap', async () => {
    const session = createTestSession();
    const stream = 'tool@test#abc001' as StreamTabId;
    session.transcripts.ensureStream(stream);
    session.followUps.claimLive(stream, 'flow');
    let unblockDeletion!: () => void;
    const deletionBlocked = new Promise<void>((resolve) => {
      unblockDeletion = resolve;
    });
    const deleteExecution = vi.fn(
      async (executionId: ExecutionId, options?: DeleteExecutionOptions) => {
        await deletionBlocked;
        await options?.beforeDelete?.();
        return { status: 'deleted' as const, executionId };
      },
    );
    const releases: StreamTabId[] = [];
    session.followUps.onRelease((released) => releases.push(released));
    const snapshots = new StreamSnapshotStore();
    // Ownership is the sidecar FK, never the stream-name suffix.
    ownExecution(snapshots, stream, 'abc001' as ExecutionId);
    const stores = new SessionStores({
      streamLogs: session.transcripts,
      snapshots,
      deleteExecution,
      onCanonicalStreamDeleted: (deleted) =>
        releaseStreamResources(deleted, session),
    });

    try {
      const single = stores.deleteStream(stream);
      await vi.waitFor(() => expect(deleteExecution).toHaveBeenCalledOnce());
      const bulk = stores.deleteAll();
      unblockDeletion();

      await expect(Promise.all([single, bulk])).resolves.toEqual([
        'deleted',
        { active: new Set(), failed: new Set() },
      ]);
      expect(releases).toEqual([stream]);
    } finally {
      session.dispose();
    }
  });

  it('releases deleted streams and excludes retained active streams', async () => {
    const session = createTestSession();
    const deleted = 'canonical-delete' as StreamTabId;
    const retained = 'tool@test#ac71e1' as StreamTabId;
    session.transcripts.ensureStream(deleted);
    session.transcripts.ensureStream(retained);
    const releases: StreamTabId[] = [];
    session.followUps.onRelease((stream) => releases.push(stream));
    const snapshots = new StreamSnapshotStore();
    // The retained stream owns its execution through the sidecar FK; the
    // deleted stream has none and only its adjacent state is removed.
    ownExecution(snapshots, retained, 'ac71e1' as ExecutionId);
    const stores = new SessionStores({
      streamLogs: session.transcripts,
      snapshots,
      deleteExecution: async (executionId) => ({
        status: 'active',
        executionId,
        heartbeatAt: Date.now(),
      }),
      onCanonicalStreamDeleted: (stream) =>
        releaseStreamResources(stream, session),
    });

    try {
      const result = await stores.deleteAll();

      expect(result.active).toEqual(new Set([retained]));
      expect(result.failed).toEqual(new Set());
      expect(releases).toEqual([deleted]);
    } finally {
      session.dispose();
    }
  });
});

describe('SessionStores deletion admission (#9590 A2)', () => {
  it('never lets suffix resemblance authorize deleting an execution registered to another stream', async () => {
    const session = createTestSession();
    const executionId = 'abc777' as ExecutionId;
    const ownerStream = `owner@model#${executionId}` as StreamTabId;
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-31T00:00:00.000Z',
      streamId: ownerStream,
    });
    // Carries the execution's id as a name suffix but has no sidecar
    // ownership: a formatting hint, not deletion authority.
    const impostor = `rogue@model#${executionId}` as StreamTabId;
    session.transcripts.ensureStream(impostor);
    const deleteExecution = deletionSpy();
    const stores = new SessionStores({
      streamLogs: session.transcripts,
      snapshots: new StreamSnapshotStore(),
      deleteExecution,
    });

    try {
      await expect(stores.deleteStream(impostor)).resolves.toBe('deleted');
      expect(deleteExecution).not.toHaveBeenCalled();
      await expect(
        getExecutionStore(executionId).readMeta(),
      ).resolves.toMatchObject({ streamId: ownerStream });
    } finally {
      session.dispose();
    }
  });

  it('propagates sidecar FK storage failures instead of deciding ownership', async () => {
    const session = createTestSession();
    const executionId = 'abc111' as ExecutionId;
    const stream = `flaky@model#${executionId}` as StreamTabId;
    session.transcripts.ensureStream(stream);
    const snapshots = new StreamSnapshotStore();
    const readPersistedExecutionId = vi
      .spyOn(snapshots, 'readPersistedExecutionId')
      .mockRejectedValue(new Error('storage read failed'));
    const deleteExecution = deletionSpy();
    const stores = new SessionStores({
      streamLogs: session.transcripts,
      snapshots,
      deleteExecution,
    });

    try {
      await expect(stores.deleteStream(stream)).rejects.toThrow(
        'storage read failed',
      );
      expect(deleteExecution).not.toHaveBeenCalled();
      expect(session.transcripts.has(stream)).toBe(true);
    } finally {
      readPersistedExecutionId.mockRestore();
      session.dispose();
    }
  });

  it('retains only the unreadable stream during bulk deletion, deleting the rest', async () => {
    const session = createTestSession();
    const flakyExecutionId = 'abc222' as ExecutionId;
    const goodExecutionId = 'abc333' as ExecutionId;
    const flakyStream = `flaky@model#${flakyExecutionId}` as StreamTabId;
    const goodStream = `good@model#${goodExecutionId}` as StreamTabId;
    session.transcripts.ensureStream(flakyStream);
    session.transcripts.ensureStream(goodStream);
    const snapshots = new StreamSnapshotStore();
    // The good stream owns its execution through the sidecar FK; the flaky
    // stream's persisted FK is unreadable.
    ownExecution(snapshots, goodStream, goodExecutionId);
    vi.spyOn(snapshots, 'listPersistedStreams').mockResolvedValue([
      flakyStream,
    ]);
    const readPersistedExecutionId = vi
      .spyOn(snapshots, 'readPersistedExecutionId')
      .mockRejectedValue(new Error('storage read failed'));
    const warn = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const deleteExecution = deletionSpy();
    const stores = new SessionStores({
      streamLogs: session.transcripts,
      snapshots,
      deleteExecution,
    });

    try {
      const result = await stores.deleteAll();

      expect(result.failed).toEqual(new Set([flakyStream]));
      expect(deleteExecution).toHaveBeenCalledWith(
        goodExecutionId,
        expect.anything(),
      );
      expect(deleteExecution).not.toHaveBeenCalledWith(
        flakyExecutionId,
        expect.anything(),
      );
      expect(session.transcripts.has(flakyStream)).toBe(true);
      expect(session.transcripts.has(goodStream)).toBe(false);
    } finally {
      readPersistedExecutionId.mockRestore();
      warn.mockRestore();
      session.dispose();
    }
  });

  it('never derives ownership from a name suffix, even for legacy records without a sidecar FK', async () => {
    const session = createTestSession();
    const executionId = 'abc888' as ExecutionId;
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-31T00:00:00.000Z',
    });
    const stream = `legacy@model#${executionId}` as StreamTabId;
    session.transcripts.ensureStream(stream);
    const deleteExecution = deletionSpy();
    const stores = new SessionStores({
      streamLogs: session.transcripts,
      snapshots: new StreamSnapshotStore(),
      deleteExecution,
    });

    try {
      await expect(stores.deleteStream(stream)).resolves.toBe('deleted');
      expect(deleteExecution).not.toHaveBeenCalled();
      await expect(
        getExecutionStore(executionId).readMeta(),
      ).resolves.not.toBeNull();
    } finally {
      session.dispose();
    }
  });
});

describe('SessionStores ephemeral sweep', () => {
  const shell = 'bash@tool#4f4f4f4f4f4f' as StreamTabId;
  const realSession = 'chat@deepseek#5f5f5f5f5f5f' as StreamTabId;

  it('deletes leftover background shells and nothing else', async () => {
    const stores = new SessionStores({
      streamLogs: await StreamLogStore.open(),
      snapshots: new StreamSnapshotStore(),
    });
    const deleteStream = vi.spyOn(stores, 'deleteStream');

    const swept = await stores.sweepEphemeralStreams(
      new Set([shell, realSession]),
    );

    expect(swept).toEqual([shell]);
    expect(deleteStream).toHaveBeenCalledTimes(1);
    expect(deleteStream).toHaveBeenCalledWith(shell);
  });

  it('keeps a shell whose deletion is refused, and says so', async () => {
    const stores = new SessionStores({
      streamLogs: await StreamLogStore.open(),
      snapshots: new StreamSnapshotStore(),
    });
    // What a still-running shell looks like here: it holds its execution lease,
    // so the durable lifecycle refuses the delete rather than cutting it short.
    vi.spyOn(stores, 'deleteStream').mockResolvedValue('active');
    const warn = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});

    const swept = await stores.sweepEphemeralStreams(new Set([shell]));

    expect(swept).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'SessionStores',
      '1 leftover background-shell stream(s) could not be swept and stay listed.',
      { data: { retained: [shell] } },
    );
  });
});

describe('SessionStores orphan sweep', () => {
  const orphan = 'orphaned-sidecar' as StreamTabId;

  function orphanedSnapshots(): StreamSnapshotStore {
    const snapshots = new StreamSnapshotStore();
    vi.spyOn(snapshots, 'listPersistedStreams').mockResolvedValue([orphan]);
    return snapshots;
  }

  it('removes persisted state a persistent transcript index no longer lists', async () => {
    const snapshots = orphanedSnapshots();
    const stageDeleteStream = vi.spyOn(snapshots, 'stageDeleteStream');
    const stores = new SessionStores({
      streamLogs: await StreamLogStore.open(),
      snapshots,
    });

    const result = await stores.sweepOrphanedStreams(new Set());

    expect(result.streams).toEqual([orphan]);
    expect(stageDeleteStream).toHaveBeenCalledWith(orphan);
  });

  it('skips the sweep when a degraded host runs on an ephemeral transcript index', async () => {
    const snapshots = orphanedSnapshots();
    const stageDeleteStream = vi.spyOn(snapshots, 'stageDeleteStream');
    const warn = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const stores = new SessionStores({
      streamLogs: StreamLogStore.ephemeral('transcript open failed'),
      snapshots,
    });

    const result = await stores.sweepOrphanedStreams(new Set());

    expect(result).toEqual({ streams: [], executionIds: [] });
    expect(stageDeleteStream).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'SessionStores',
      'Skipped the orphaned-stream sweep: the transcript index is ephemeral and cannot say which persisted streams are still live.',
    );
  });
});
