// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { getExecutionStore, SessionStores } from '@agent/storage';
import type { DeleteExecutionOptions } from '@agent/storage/executionListing';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import * as logUtils from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { snapshotFacts } from '@test/support/storeTestDrivers';
import { releaseStreamResources } from '@tools/approval';
import { StreamLogStore, StreamSnapshotStore } from '@transcript';

// One restore after each test covers every vi.spyOn in this file.
afterEach(() => {
  vi.restoreAllMocks();
});

/** Run `fn` against an isolated session that is always disposed. */
async function withSession<T>(
  fn: (session: SessionHandle) => Promise<T>,
): Promise<T> {
  const session = createTestSession();
  try {
    return await fn(session);
  } finally {
    session.dispose();
  }
}

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
  it('detaches durable child parent edges only after deleting the parent', async () => {
    await withSession(async (session) => {
      const parent = 'deleted-parent' as StreamTabId;
      const child = 'retained-child' as StreamTabId;
      const childExecution = 'c9862001' as ExecutionId;
      session.transcripts.ensureStream(parent);
      session.transcripts.ensureStream(child);
      const snapshots = new StreamSnapshotStore();
      ownExecution(snapshots, child, childExecution);
      snapshotFacts(snapshots).setParentStream(child, parent);
      await snapshots.flush();
      const reloadedSnapshots = new StreamSnapshotStore();
      const projectionFacts = snapshotFacts(reloadedSnapshots);
      const detached: Array<[StreamTabId, readonly StreamTabId[]]> = [];
      const stores = new SessionStores({
        streamLogs: session.transcripts,
        snapshots: reloadedSnapshots,
        onChildrenDetached: (deletedParent, children) => {
          detached.push([deletedParent, children]);
          for (const detachedChild of children) {
            projectionFacts.setParentStream(detachedChild, null);
          }
        },
      });

      await expect(stores.deleteStream(parent)).resolves.toBe('deleted');
      expect(reloadedSnapshots.getParentStreamId(child)).toBeUndefined();
      expect(reloadedSnapshots.getRunMetadata(child).executionId).toBe(
        childExecution,
      );
      expect(detached).toEqual([[parent, [child]]]);
    });
  });

  it('deletes the sidecar-named execution when the summary mirror diverges', async () => {
    await withSession(async (session) => {
      const stream = 'divergent@test#bbb00002' as StreamTabId;
      const summaryExecutionId = 'aaa00001' as ExecutionId;
      const sidecarExecutionId = 'bbb00002' as ExecutionId;
      session.transcripts.ensureStream(stream);
      session.transcripts.recordSummaryMeta(stream, {
        executionId: summaryExecutionId,
      });
      const snapshots = new StreamSnapshotStore();
      ownExecution(snapshots, stream, sidecarExecutionId);
      await snapshots.flush();
      snapshots.evictAll();
      const deleteExecution = deletionSpy();
      const stores = new SessionStores({
        streamLogs: session.transcripts,
        snapshots,
        deleteExecution,
      });

      await expect(stores.deleteStream(stream)).resolves.toBe('deleted');

      expect(deleteExecution).toHaveBeenCalledWith(
        sidecarExecutionId,
        expect.anything(),
      );
      expect(deleteExecution).not.toHaveBeenCalledWith(
        summaryExecutionId,
        expect.anything(),
      );
    });
  });

  it('waits on the resident execution during an unflushed run.start, not the stale sidecar FK', async () => {
    await withSession(async (session) => {
      const stream = 'unflushed@test#cur00001' as StreamTabId;
      const previousExecutionId = 'old00001' as ExecutionId;
      const currentExecutionId = 'new00001' as ExecutionId;
      session.transcripts.ensureStream(stream);
      const snapshots = new StreamSnapshotStore();
      // Persist the previous run's sidecar FK first.
      ownExecution(snapshots, stream, previousExecutionId);
      await snapshots.flush();
      // `run.start` updates the resident record synchronously; the sidecar FK
      // write is queued and still names the previous execution until run-end
      // flush. Single-stream deletion must wait on the current execution.
      snapshotFacts(snapshots).setRunStart({
        streamId: stream,
        executionId: currentExecutionId,
        identity: { kind: 'agent', agent: 'assistant' },
      });
      const deleteExecution = deletionSpy();
      const stores = new SessionStores({
        streamLogs: session.transcripts,
        snapshots,
        deleteExecution,
      });

      await expect(stores.deleteStream(stream)).resolves.toBe('deleted');

      expect(deleteExecution).toHaveBeenCalledWith(
        currentExecutionId,
        expect.anything(),
      );
      expect(deleteExecution).not.toHaveBeenCalledWith(
        previousExecutionId,
        expect.anything(),
      );
    });
  });

  it('projects child detachment when durable discovery fails', async () => {
    await withSession(async (session) => {
      const parent = 'discovery-failure-parent' as StreamTabId;
      session.transcripts.ensureStream(parent);
      const snapshots = new StreamSnapshotStore();
      vi.spyOn(snapshots, 'listPersistedStreams').mockRejectedValueOnce(
        new Error('sidecar unavailable'),
      );
      const onChildrenDetached = vi.fn();
      const stores = new SessionStores({
        streamLogs: session.transcripts,
        snapshots,
        onChildrenDetached,
      });

      await expect(stores.deleteStream(parent)).resolves.toBe('deleted');
      expect(onChildrenDetached).toHaveBeenCalledWith(parent, []);
    });
  });

  it('keeps a committed deletion successful when child projection fails', async () => {
    await withSession(async (session) => {
      const parent = 'projection-failure-parent' as StreamTabId;
      const child = 'projection-failure-child' as StreamTabId;
      session.transcripts.ensureStream(parent);
      session.transcripts.ensureStream(child);
      const snapshots = new StreamSnapshotStore();
      snapshotFacts(snapshots).setParentStream(child, parent);
      await snapshots.flush();
      const stores = new SessionStores({
        streamLogs: session.transcripts,
        snapshots,
        onChildrenDetached: () => {
          throw new Error('renderer unavailable');
        },
      });

      await expect(stores.deleteStream(parent)).resolves.toBe('deleted');
      expect(session.transcripts.has(parent)).toBe(false);
      expect(snapshots.getParentStreamId(child)).toBe(parent);
    });
  });

  it('tracks lease-gated deletion without blocking its artifact flush', async () => {
    await withSession(async (session) => {
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
      }
    });
  });

  it('releases one canonical stream once when single and bulk deletion overlap', async () => {
    await withSession(async (session) => {
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
      // In production this sidecar fact is mirrored into the always-resident
      // summary by the session-attached snapshot store; the isolated store
      // fixture records that same fact directly.
      session.transcripts.recordSummaryMeta(stream, {
        executionId: 'abc001' as ExecutionId,
      });
      const stores = new SessionStores({
        streamLogs: session.transcripts,
        snapshots,
        deleteExecution,
        onCanonicalStreamDeleted: (deleted) =>
          releaseStreamResources(deleted, session),
      });

      const single = stores.deleteStream(stream);
      await vi.waitFor(() => expect(deleteExecution).toHaveBeenCalledOnce());
      const bulk = stores.deleteAll();
      unblockDeletion();

      const [singleResult, bulkResult] = await Promise.all([single, bulk]);
      expect(singleResult).toBe('deleted');
      expect(bulkResult.active).toEqual(new Set());
      expect(bulkResult.failed).toEqual(new Set());
      expect(releases).toEqual([stream]);
    });
  });

  it('releases deleted streams and excludes retained active streams', async () => {
    await withSession(async (session) => {
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
      // In production this sidecar fact is mirrored into the always-resident
      // summary by the session-attached snapshot store; the isolated store
      // fixture records that same fact directly.
      session.transcripts.recordSummaryMeta(retained, {
        executionId: 'ac71e1' as ExecutionId,
      });
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

      const result = await stores.deleteAll();

      expect(result.active).toEqual(new Set([retained]));
      expect(result.failed).toEqual(new Set());
      expect(releases).toEqual([deleted]);
    });
  });
});

describe('SessionStores deletion admission (#9590 A2)', () => {
  it('never lets suffix resemblance authorize deleting an execution registered to another stream', async () => {
    await withSession(async (session) => {
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

      await expect(stores.deleteStream(impostor)).resolves.toBe('deleted');
      expect(deleteExecution).not.toHaveBeenCalled();
      await expect(
        getExecutionStore(executionId).readMeta(),
      ).resolves.toMatchObject({ streamId: ownerStream });
    });
  });

  it('returns failed rather than rejecting when ownership storage is unreadable', async () => {
    await withSession(async (session) => {
      const executionId = 'abc111' as ExecutionId;
      const stream = `flaky@model#${executionId}` as StreamTabId;
      session.transcripts.ensureStream(stream);
      const snapshots = new StreamSnapshotStore();
      vi.spyOn(snapshots, 'readPersistedExecutionId').mockRejectedValue(
        new Error('storage read failed'),
      );
      const deleteExecution = deletionSpy();
      const stores = new SessionStores({
        streamLogs: session.transcripts,
        snapshots,
        deleteExecution,
      });

      await expect(stores.deleteStream(stream)).resolves.toBe('failed');
      expect(deleteExecution).not.toHaveBeenCalled();
      expect(session.transcripts.has(stream)).toBe(true);
    });
  });

  it('retains only the unreadable stream during bulk deletion, deleting the rest', async () => {
    await withSession(async (session) => {
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
      vi.spyOn(snapshots, 'readPersistedExecutionId').mockRejectedValue(
        new Error('storage read failed'),
      );
      vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
      const deleteExecution = deletionSpy();
      const stores = new SessionStores({
        streamLogs: session.transcripts,
        snapshots,
        deleteExecution,
      });

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
    });
  });

  it('bulk deletion preserves resident ownership and skips its sidecar read', async () => {
    await withSession(async (session) => {
      const executionId = 'abc444' as ExecutionId;
      const stream = `resident@model#${executionId}` as StreamTabId;
      session.transcripts.ensureStream(stream);
      const snapshots = new StreamSnapshotStore();
      ownExecution(snapshots, stream, executionId);
      vi.spyOn(snapshots, 'listPersistedStreams').mockResolvedValue([stream]);
      vi.spyOn(snapshots, 'listStagedDeletions').mockResolvedValue([]);
      vi.spyOn(snapshots, 'readPersistedExecutionId').mockRejectedValue(
        new Error('sidecar should not be read for a resident stream'),
      );
      const deleteExecution = deletionSpy();
      const stores = new SessionStores({
        streamLogs: session.transcripts,
        snapshots,
        deleteExecution,
      });

      const result = await stores.deleteAll();

      expect(result.failed).toEqual(new Set());
      expect(deleteExecution).toHaveBeenCalledWith(
        executionId,
        expect.anything(),
      );
      expect(session.transcripts.has(stream)).toBe(false);
    });
  });

  it('never derives ownership from a name suffix, even for legacy records without a sidecar FK', async () => {
    await withSession(async (session) => {
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

      await expect(stores.deleteStream(stream)).resolves.toBe('deleted');
      expect(deleteExecution).not.toHaveBeenCalled();
      await expect(
        getExecutionStore(executionId).readMeta(),
      ).resolves.not.toBeNull();
    });
  });
});

describe('SessionStores startup sweep', () => {
  const shell = 'bash@tool#4f4f4f4f4f4f' as StreamTabId;
  const realSession = 'chat@deepseek#5f5f5f5f5f5f' as StreamTabId;
  // A shell-named stream whose summary never mirrored its identity meta:
  // the sweep keys on `RunIdentity`, never the name prefix, so it stays.
  const preMetaShell = 'bash@tool#6f6f6f6f6f6f' as StreamTabId;

  /**
   * Stores over a transcript index holding one identity-stamped shell, one
   * real agent session, and one pre-meta shell-named stream.
   */
  async function storesWithLeftovers(): Promise<SessionStores> {
    const streamLogs = await StreamLogStore.open();
    streamLogs.ensureStream(shell);
    streamLogs.recordSummaryMeta(shell, {
      identity: { kind: 'process', tool: 'bash' },
    });
    streamLogs.ensureStream(realSession);
    streamLogs.recordSummaryMeta(realSession, {
      identity: { kind: 'agent', agent: 'chat' },
    });
    streamLogs.ensureStream(preMetaShell);
    const snapshots = new StreamSnapshotStore();
    // Keep the orphan half of the sweep out of this: it reads the whole
    // storage root, which other suites in this process also write.
    vi.spyOn(snapshots, 'listPersistedStreams').mockResolvedValue([]);
    vi.spyOn(snapshots, 'listStagedDeletions').mockResolvedValue([]);
    return new SessionStores({
      streamLogs,
      snapshots,
      listExecutionStreamReferences: async () => [],
    });
  }

  it('deletes leftover background shells and nothing else', async () => {
    const stores = await storesWithLeftovers();
    const deleteStream = vi
      .spyOn(stores, 'deleteStream')
      .mockResolvedValue('deleted');

    await stores.sweepLeftoverStreams();

    expect(deleteStream).toHaveBeenCalledTimes(1);
    expect(deleteStream).toHaveBeenCalledWith(shell);
  });

  it('keeps a shell whose deletion is refused, and says so', async () => {
    const stores = await storesWithLeftovers();
    // What a still-running shell looks like here: it holds its execution lease,
    // so the durable lifecycle refuses the delete rather than cutting it short.
    vi.spyOn(stores, 'deleteStream').mockResolvedValue('active');
    const warn = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});

    await stores.sweepLeftoverStreams();

    expect(warn).toHaveBeenCalledWith(
      'SessionStores',
      '1 leftover background-shell stream(s) could not be swept and stay listed.',
      { data: { retained: [shell] } },
    );
  });

  it('survives a deletion that throws, and still reaches the orphan sweep', async () => {
    const stores = await storesWithLeftovers();
    vi.spyOn(stores, 'deleteStream').mockRejectedValue(
      new Error('sidecar unreadable'),
    );
    const warn = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});

    // One unreadable leftover must not fail the load that called the sweep.
    await expect(stores.sweepLeftoverStreams()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'SessionStores',
      `Failed to sweep leftover background shell ${shell}: sidecar unreadable`,
      expect.anything(),
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

  function emptySnapshots(): StreamSnapshotStore {
    const snapshots = new StreamSnapshotStore();
    vi.spyOn(snapshots, 'listPersistedStreams').mockResolvedValue([]);
    vi.spyOn(snapshots, 'listStagedDeletions').mockResolvedValue([]);
    return snapshots;
  }

  it('removes persisted state a persistent transcript index no longer lists', async () => {
    const snapshots = orphanedSnapshots();
    const stageDeleteStream = vi.spyOn(snapshots, 'stageDeleteStream');
    const stores = new SessionStores({
      streamLogs: await StreamLogStore.open(),
      snapshots,
      listExecutionStreamReferences: async () => [],
    });

    const result = await stores.sweepOrphanedStreams(new Set());

    expect(result.streams).toEqual([orphan]);
    expect(stageDeleteStream).toHaveBeenCalledWith(
      orphan,
      expect.any(Function),
    );
  });

  it('removes an execution whose stream lost its sidecar FK before deletion', async () => {
    const executionId = 'f9891001' as ExecutionId;
    const stream = 'missing-fk-stream' as StreamTabId;
    const streamLogs = await StreamLogStore.open();
    streamLogs.ensureStream(stream);
    const deleteExecution = deletionSpy();
    const stores = new SessionStores({
      streamLogs,
      snapshots: emptySnapshots(),
      deleteExecution,
      listExecutionStreamReferences: async () => [
        { executionId, streamId: stream },
      ],
    });

    // The sidecar never received its execution FK, so normal stream deletion
    // removes only the transcript and sidecar state.
    await expect(stores.deleteStream(stream)).resolves.toBe('deleted');
    const info = vi.spyOn(logUtils, 'info').mockImplementation(() => {});

    await stores.sweepLeftoverStreams();

    expect(deleteExecution).toHaveBeenCalledWith(executionId);
    expect(info).toHaveBeenCalledWith(
      'SessionStores',
      'Removed 0 orphaned stream sidecar(s) and 1 execution dir(s).',
      {
        data: { streams: [], executionIds: [executionId] },
      },
    );
  });

  it('preserves an execution still referenced by a live transcript stream', async () => {
    const executionId = 'f9891002' as ExecutionId;
    const stream = 'live-stream' as StreamTabId;
    const streamLogs = await StreamLogStore.open();
    streamLogs.ensureStream(stream);
    const deleteExecution = deletionSpy();
    const stores = new SessionStores({
      streamLogs,
      snapshots: emptySnapshots(),
      deleteExecution,
      listExecutionStreamReferences: async () => [
        { executionId, streamId: stream },
      ],
    });

    const result = await stores.sweepOrphanedStreams(
      new Set(streamLogs.keys()),
    );

    expect(result.executionIds).toEqual([]);
    expect(deleteExecution).not.toHaveBeenCalled();
  });

  it('preserves an execution added by another host after this store opens', async () => {
    const executionId = 'f9891004' as ExecutionId;
    const stream = 'other-host-stream' as StreamTabId;
    const streamLogsA = await StreamLogStore.open();
    const streamLogsB = await StreamLogStore.open();
    const deleteExecution = deletionSpy();
    const stores = new SessionStores({
      streamLogs: streamLogsA,
      snapshots: emptySnapshots(),
      deleteExecution,
      listExecutionStreamReferences: async () => [
        { executionId, streamId: stream },
      ],
    });

    // Store A has already loaded its index. A second host now durably creates
    // the execution's transcript stream, which must win over A's stale cache.
    streamLogsB.ensureStream(stream);
    await streamLogsB.flush();

    const result = await stores.sweepOrphanedStreams(
      new Set(streamLogsA.keys()),
    );

    expect(result.executionIds).toEqual([]);
    expect(deleteExecution).not.toHaveBeenCalled();
    await streamLogsB.delete(stream);
  });

  it('preserves an orphaned execution while its lease is active', async () => {
    const executionId = 'f9891003' as ExecutionId;
    const stream = 'deleted-active-stream' as StreamTabId;
    const deleteExecution = vi.fn(async () => ({
      status: 'active' as const,
      executionId,
      heartbeatAt: Date.now(),
    }));
    const stores = new SessionStores({
      streamLogs: await StreamLogStore.open(),
      snapshots: emptySnapshots(),
      deleteExecution,
      listExecutionStreamReferences: async () => [
        { executionId, streamId: stream },
      ],
    });

    const result = await stores.sweepOrphanedStreams(new Set());

    expect(result.executionIds).toEqual([]);
    expect(deleteExecution).toHaveBeenCalledWith(executionId);
  });

  it('preserves executions when the metadata scan fails', async () => {
    const deleteExecution = deletionSpy();
    const warn = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const stores = new SessionStores({
      streamLogs: await StreamLogStore.open(),
      snapshots: emptySnapshots(),
      deleteExecution,
      listExecutionStreamReferences: async () => {
        throw new Error('execution directory unreadable');
      },
    });

    const result = await stores.sweepOrphanedStreams(new Set());

    expect(result.executionIds).toEqual([]);
    expect(deleteExecution).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'SessionStores',
      'Skipping execution-side orphan cleanup; startup will continue: execution directory unreadable',
      expect.anything(),
    );
  });

  it('skips the sweep when a degraded host runs on an ephemeral transcript index', async () => {
    const snapshots = orphanedSnapshots();
    const stageDeleteStream = vi.spyOn(snapshots, 'stageDeleteStream');
    const warn = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const stores = new SessionStores({
      streamLogs: StreamLogStore.ephemeral('transcript open failed'),
      snapshots,
      listExecutionStreamReferences: async () => [],
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
