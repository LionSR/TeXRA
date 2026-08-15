import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { flowKey } from '@agent/node/persistedFlow';
import {
  acquireFreshExecutionLease,
  completeOwnedExecutionLease,
  EXECUTION_LEASE_STALE_MS,
  resetExecutionLeaseCoordinationForTests,
} from '@agent/storage/executionLease';
import * as waitingDetection from '@agent/storage/detectWaitingStreams';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import * as restartRepair from '@agent/runtime/restartRepair';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { platform } from '@platform/platform';
import {
  LOG_LEVELS,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { writeForeignLease } from '@test/support/executionLeaseFixtures';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  appendTranscriptEntry,
  snapshotFacts,
} from '@test/support/storeTestDrivers';
import { StreamLogStore, StreamSnapshotStore } from '@transcript';
import { StorageFS } from '@utils/files/storageFS';

setupPlatform({ workspacePath: '/workspace/session-restart-repair' });

const executionId = 'abc123' as ExecutionId;
const streamId = `crashed#${executionId}` as StreamTabId;
const META_TIMESTAMP = '2026-07-26T00:00:00.000Z';
const validFlowRecord = {
  flowName: 'texra',
  shared: { messages: [] },
  createdAt: META_TIMESTAMP,
  cursor: { nextNodeId: 'start' },
  nodes: [],
};

/** Sessions opened by a test, disposed in afterEach (dispose is idempotent). */
const sessions: SessionHandle[] = [];

function trackSession(session: SessionHandle): SessionHandle {
  sessions.push(session);
  return session;
}

function openDeferredSession(transcripts: StreamLogStore): SessionHandle {
  return trackSession(
    new SessionHandle({ transcripts, restartRepair: 'deferred' }),
  );
}

function appendRunningGroup(
  transcripts: StreamLogStore,
  stream: StreamTabId,
  id: string,
  timestamp = 1_000,
): void {
  appendTranscriptEntry(transcripts, stream, {
    id,
    type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
    level: LOG_LEVELS.INFO,
    timestamp,
    data: { status: STREAM_PHASE.RUNNING },
  });
}

function expectClosedWith(
  transcripts: StreamLogStore,
  stream: StreamTabId,
  status: string,
): void {
  expect(transcripts.get(stream)?.getRange(0).at(-1)).toMatchObject({
    type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
    data: { status },
  });
}

/**
 * Persist the stream→execution sidecar FK — since Axis T the ONE reverse
 * edge restart repair recognizes; name suffixes are never ownership.
 */
async function seedSidecarFk(
  stream: StreamTabId,
  ownedExecutionId: ExecutionId,
): Promise<void> {
  const snapshots = new StreamSnapshotStore();
  snapshotFacts(snapshots).setRunConfig(
    stream,
    AgentConfigSchema.parse({
      agent: 'chat',
      model: 'deepseekT',
      agentCategory: 'toolUse',
    }),
    ownedExecutionId,
  );
  await snapshots.flush();
}

/**
 * Mocks a pending workspace-storage root change, returning the commit mock so
 * callers can assert whether it was invoked.
 */
function mockPendingWorkspaceChange(
  opts: { pending?: boolean; commit?: boolean } = {},
): Mock<() => boolean> {
  const commitWorkspaceStorageChange = vi.fn(() => opts.commit ?? true);
  Object.assign(platform().storage, {
    hasPendingWorkspaceStorageChange: () => opts.pending ?? true,
    commitWorkspaceStorageChange,
  });
  return commitWorkspaceStorageChange;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions) {
    session.dispose();
  }
  sessions.length = 0;
  for (const directory of [
    WORKSPACE_STORAGE_LAYOUT.executionLeases,
    'executions',
    'streamData',
    'streamLogs',
    'streamLogSummaries',
  ]) {
    await StorageFS.delete(directory, { recursive: true }).catch(
      () => undefined,
    );
  }
  clearStoreCache();
  resetExecutionLeaseCoordinationForTests();
});

describe('SessionHandle restart repair', () => {
  it('stops in-flight restart repair when the session is disposed', async () => {
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, streamId, 'disposed-running-group');
    await transcripts.flush();

    let finishDetection: ((streams: Set<StreamTabId>) => void) | undefined;
    const detectionBlocked = new Promise<Set<StreamTabId>>((resolve) => {
      finishDetection = resolve;
    });
    vi.spyOn(waitingDetection, 'detectWaitingStreams').mockReturnValue(
      detectionBlocked,
    );

    const session = openDeferredSession(transcripts);
    const readiness = session.waitUntilReady();
    await vi.waitFor(() => {
      expect(waitingDetection.detectWaitingStreams).toHaveBeenCalledOnce();
    });

    session.dispose();
    finishDetection?.(new Set());
    await expect(readiness).resolves.toBeUndefined();

    expect(session.status.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(transcripts.get(streamId)?.getRange(0)).toHaveLength(1);
    await expect(getExecutionStore(executionId).readMeta()).resolves.toBeNull();
  });

  it('repairs a crashed run before a host is attached', async () => {
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, streamId, 'crashed-running-group');
    await transcripts.flush();
    await seedSidecarFk(streamId, executionId);

    const executionStore = getExecutionStore(executionId);
    await executionStore.writeMeta({ timestamp: META_TIMESTAMP });
    await executionStore.write(flowKey(executionId), { invalid: true });

    await writeForeignLease(
      executionId,
      Date.now() - EXECUTION_LEASE_STALE_MS - 1,
    );

    const session = openDeferredSession(transcripts);
    await session.waitUntilReady();

    expect(session.status.get(streamId)).toBe(STREAM_PHASE.FAILED);
    await expect(executionStore.readMeta()).resolves.toMatchObject({
      outcome: RUN_OUTCOME.FAILED,
    });
    await expect(
      executionStore.read(flowKey(executionId)),
    ).resolves.toBeUndefined();
    expectClosedWith(transcripts, streamId, RUN_OUTCOME.FAILED);
  });

  // The CLI and the VS Code extension open the process session without
  // `restartRepair: 'deferred'`; desktop is the only host that defers repair
  // while it claims legacy stream identities.
  it('starts one repair pass at construction when the host does not defer it', async () => {
    const eagerExecutionId = 'eager1234567' as ExecutionId;
    const eagerStreamId = `eager#${eagerExecutionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, eagerStreamId, 'eager-running-group');
    await transcripts.flush();

    const executionStore = getExecutionStore(eagerExecutionId);
    await executionStore.writeMeta({ timestamp: META_TIMESTAMP });
    await executionStore.write(flowKey(eagerExecutionId), validFlowRecord);
    const detectWaiting = vi
      .spyOn(waitingDetection, 'detectWaitingStreams')
      .mockResolvedValue(new Set());

    const session = trackSession(new SessionHandle({ transcripts }));
    await vi.waitFor(() => expect(detectWaiting).toHaveBeenCalledOnce());
    await session.waitUntilReady();

    expect(detectWaiting).toHaveBeenCalledOnce();
    expect(session.status.get(eagerStreamId)).toBe(STREAM_PHASE.FAILED);
    expectClosedWith(transcripts, eagerStreamId, RUN_OUTCOME.FAILED);
  });

  it('preserves recovery state when present execution metadata is malformed', async () => {
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, streamId, 'malformed-meta-running-group');
    await transcripts.flush();
    await seedSidecarFk(streamId, executionId);

    const executionStore = getExecutionStore(executionId);
    const malformedMeta = { timestamp: 123 };
    await executionStore.write('meta', malformedMeta);
    await executionStore.write(flowKey(executionId), validFlowRecord);

    const session = openDeferredSession(transcripts);
    await expect(session.waitUntilReady()).rejects.toThrow();

    await expect(executionStore.read('meta')).resolves.toEqual(malformedMeta);
    await expect(executionStore.read(flowKey(executionId))).resolves.toEqual(
      validFlowRecord,
    );
    expect(transcripts.get(streamId)?.getRange(0)).toHaveLength(1);
  });

  it('ignores malformed metadata for settled historical streams', async () => {
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, streamId, 'settled-history-running-group');
    await transcripts.endRunningGroupsForStreams(
      [streamId],
      2_000,
      RUN_OUTCOME.COMPLETED,
    );
    await transcripts.flush();
    const executionStore = getExecutionStore(executionId);
    const malformedMeta = { timestamp: null };
    await executionStore.write('meta', malformedMeta);

    const session = openDeferredSession(transcripts);
    await expect(session.waitUntilReady()).resolves.toBeUndefined();
    await expect(executionStore.read('meta')).resolves.toEqual(malformedMeta);
  });

  it('closes an orphaned group without rewriting its completed execution', async () => {
    const completedExecutionId = 'c0ffee123' as ExecutionId;
    const completedStreamId =
      `completed#${completedExecutionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(
      transcripts,
      completedStreamId,
      'completed-running-group',
    );
    await transcripts.flush();
    await seedSidecarFk(completedStreamId, completedExecutionId);

    const executionStore = getExecutionStore(completedExecutionId);
    await executionStore.writeMeta({
      timestamp: META_TIMESTAMP,
      outcome: RUN_OUTCOME.COMPLETED,
    });

    const session = openDeferredSession(transcripts);
    await session.waitUntilReady();

    expect(session.status.get(completedStreamId)).toBe(STREAM_PHASE.COMPLETED);
    await expect(executionStore.readMeta()).resolves.toMatchObject({
      outcome: RUN_OUTCOME.COMPLETED,
    });
    expectClosedWith(transcripts, completedStreamId, RUN_OUTCOME.COMPLETED);
  });

  it('detects a resumable run from its persisted sidecar FK', async () => {
    const resumableExecutionId = 'facade123' as ExecutionId;
    const resumableStreamId =
      `resumable#${resumableExecutionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(
      transcripts,
      resumableStreamId,
      'resumable-running-group',
    );
    await transcripts.flush();
    await seedSidecarFk(resumableStreamId, resumableExecutionId);

    const executionStore = getExecutionStore(resumableExecutionId);
    await executionStore.writeMeta({
      timestamp: META_TIMESTAMP,
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await executionStore.write(flowKey(resumableExecutionId), validFlowRecord);

    const session = openDeferredSession(transcripts);
    await session.waitUntilReady();

    expect(
      session.snapshots.getRunMetadata(resumableStreamId).executionId,
    ).toBe(resumableExecutionId);
    expect(session.status.get(resumableStreamId)).toBe(STREAM_PHASE.WAITING);
    await expect(
      executionStore.read(flowKey(resumableExecutionId)),
    ).resolves.toEqual(validFlowRecord);
    expectClosedWith(transcripts, resumableStreamId, RUN_OUTCOME.CANCELLED);
  });

  it('seeds only unfinished streams and their transitive parent chain at startup', async () => {
    const child = 'bounded#child' as StreamTabId;
    const parent = 'bounded#parent' as StreamTabId;
    const grandparent = 'bounded#grandparent' as StreamTabId;
    const settled = 'bounded#settled' as StreamTabId;
    const childExecutionId = 'b0a00001' as ExecutionId;
    const parentExecutionId = 'b0a00002' as ExecutionId;
    const grandparentExecutionId = 'b0a00003' as ExecutionId;
    const settledExecutionId = 'b0a00004' as ExecutionId;

    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, child, 'child-running-group');
    appendRunningGroup(transcripts, settled, 'settled-running-group');
    await transcripts.endRunningGroupsForStreams(
      [settled],
      2_000,
      RUN_OUTCOME.COMPLETED,
    );
    await transcripts.flush();
    transcripts.recordSummaryMeta(child, { parentStreamId: parent });
    transcripts.recordSummaryMeta(parent, { parentStreamId: grandparent });

    await seedSidecarFk(child, childExecutionId);
    await seedSidecarFk(parent, parentExecutionId);
    await seedSidecarFk(grandparent, grandparentExecutionId);
    await seedSidecarFk(settled, settledExecutionId);

    const session = openDeferredSession(transcripts);
    const preload = vi.spyOn(session.snapshots, 'preload');
    vi.spyOn(
      session as unknown as { runRestartRepair(): Promise<void> },
      'runRestartRepair',
    ).mockResolvedValue(undefined);

    await session.waitUntilReady();

    const expected = [child, parent, grandparent].sort();
    expect(preload).toHaveBeenCalledTimes(1);
    expect([...preload.mock.calls[0][0]].sort()).toEqual(expected);
    expect([...session.snapshots.getExecutionIdMap().keys()].sort()).toEqual(
      expected,
    );
  });

  it('resumes a parked WAITING stream with no resident snapshot record after restart', async () => {
    const parkedExecutionId = 'b0a00005' as ExecutionId;
    const parkedStreamId = 'parked#waiting' as StreamTabId;

    const transcripts = await StreamLogStore.open();
    transcripts.ensureStream(parkedStreamId);
    transcripts.recordSummaryMeta(parkedStreamId, {
      executionId: parkedExecutionId,
    });
    await transcripts.flush();
    await seedSidecarFk(parkedStreamId, parkedExecutionId);

    const executionStore = getExecutionStore(parkedExecutionId);
    await executionStore.writeMeta({
      timestamp: META_TIMESTAMP,
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await executionStore.write(flowKey(parkedExecutionId), validFlowRecord);

    const session = openDeferredSession(transcripts);
    vi.spyOn(
      session as unknown as { runRestartRepair(): Promise<void> },
      'runRestartRepair',
    ).mockResolvedValue(undefined);

    await session.waitUntilReady();

    // The parked stream is settled history, so the bounded startup seed leaves
    // its snapshot record absent; the follow-up repair must still resolve the
    // execution through the summary mirror and route it back to WAITING.
    expect([...session.snapshots.getExecutionIdMap().keys()]).not.toContain(
      parkedStreamId,
    );
    session.status.transition(
      parkedStreamId,
      STREAM_PHASE.CANCELLED,
      'user-stop',
    );

    await expect(
      session.repairWaitingIfResumable(parkedStreamId),
    ).resolves.toBe(true);
    expect(session.status.get(parkedStreamId)).toBe(STREAM_PHASE.WAITING);
  });

  it('resolves waiting-stream ownership from the sidecar FK when the summary mirror diverges', async () => {
    const sidecarExecutionId = 'b0a00007' as ExecutionId;
    const summaryExecutionId = 'b0a00008' as ExecutionId;
    const settledStream = 'settled#divergent-mirror' as StreamTabId;

    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, settledStream, 'settled-divergent-group');
    await transcripts.endRunningGroupsForStreams(
      [settledStream],
      2_000,
      RUN_OUTCOME.COMPLETED,
    );
    await transcripts.flush();
    transcripts.recordSummaryMeta(settledStream, {
      executionId: summaryExecutionId,
    });
    await seedSidecarFk(settledStream, sidecarExecutionId);

    const executionStore = getExecutionStore(sidecarExecutionId);
    await executionStore.writeMeta({
      timestamp: META_TIMESTAMP,
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await executionStore.write(flowKey(sidecarExecutionId), validFlowRecord);

    const session = openDeferredSession(transcripts);
    await session.waitUntilReady();

    // The summary mirror names a different (non-resumable) execution; repair
    // must follow the persisted sidecar FK and park the stream as WAITING.
    expect(session.status.get(settledStream)).toBe(STREAM_PHASE.WAITING);
  });

  it('preloads parked WAITING streams before publishing restart status', async () => {
    const parkedExecutionId = 'b0a00009' as ExecutionId;
    const parkedStreamId = 'parked#waiting-preload' as StreamTabId;

    const transcripts = await StreamLogStore.open();
    transcripts.ensureStream(parkedStreamId);
    await transcripts.flush();
    await seedSidecarFk(parkedStreamId, parkedExecutionId);

    const executionStore = getExecutionStore(parkedExecutionId);
    await executionStore.writeMeta({
      timestamp: META_TIMESTAMP,
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await executionStore.write(flowKey(parkedExecutionId), validFlowRecord);

    const session = openDeferredSession(transcripts);
    const preload = vi.spyOn(session.snapshots, 'preload');
    const repair = vi.spyOn(restartRepair, 'repairRestartedStreams');

    await session.waitUntilReady();

    expect(preload).toHaveBeenCalledTimes(2);
    expect([...preload.mock.calls[1][0]]).toEqual([parkedStreamId]);
    expect(preload.mock.invocationCallOrder[1]).toBeLessThan(
      repair.mock.invocationCallOrder[0],
    );
    expect(session.status.get(parkedStreamId)).toBe(STREAM_PHASE.WAITING);
  });

  it('isolates one unreadable parked WAITING preload so session startup still publishes WAITING', async () => {
    const parkedExecutionId = 'b0a00010' as ExecutionId;
    const parkedStreamId = 'parked#waiting-preload-failure' as StreamTabId;

    const transcripts = await StreamLogStore.open();
    transcripts.ensureStream(parkedStreamId);
    await transcripts.flush();
    await seedSidecarFk(parkedStreamId, parkedExecutionId);

    const executionStore = getExecutionStore(parkedExecutionId);
    await executionStore.writeMeta({
      timestamp: META_TIMESTAMP,
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await executionStore.write(flowKey(parkedExecutionId), validFlowRecord);

    const session = openDeferredSession(transcripts);
    const originalPreload = session.snapshots.preload.bind(session.snapshots);
    const preload = vi
      .spyOn(session.snapshots, 'preload')
      .mockImplementation(async (streamIds) => {
        if (streamIds.includes(parkedStreamId)) {
          throw new Error('parked sidecar unreadable');
        }
        await originalPreload(streamIds);
      });

    await expect(session.waitUntilReady()).resolves.toBeUndefined();

    expect(preload).toHaveBeenCalledTimes(2);
    // The stream is still marked WAITING; only its usage hydration was skipped.
    expect(session.status.get(parkedStreamId)).toBe(STREAM_PHASE.WAITING);
  });

  it('preserves mapped runs and fails only unmapped streams when resumability detection fails', async () => {
    const degradedExecutionId = 'decade123' as ExecutionId;
    const degradedStreamId = `degraded#${degradedExecutionId}` as StreamTabId;
    const unmappedStreamId = 'unmapped#no-sidecar-fk' as StreamTabId;
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, degradedStreamId, 'degraded-running-group');
    appendRunningGroup(transcripts, unmappedStreamId, 'unmapped-running-group');
    await transcripts.flush();
    await seedSidecarFk(degradedStreamId, degradedExecutionId);

    const executionStore = getExecutionStore(degradedExecutionId);
    await executionStore.writeMeta({ timestamp: META_TIMESTAMP });
    await executionStore.write(flowKey(degradedExecutionId), validFlowRecord);
    vi.spyOn(waitingDetection, 'detectWaitingStreams').mockRejectedValueOnce(
      new Error('resumability read failed'),
    );

    const session = openDeferredSession(transcripts);
    await session.waitUntilReady();

    // A mapped stream keeps its recovery state: failing it blindly could
    // destroy a flow record that is in fact resumable.
    expect(session.snapshots.getRunMetadata(degradedStreamId).executionId).toBe(
      degradedExecutionId,
    );
    expect(session.status.get(degradedStreamId)).toBe(STREAM_PHASE.RUNNING);
    await expect(
      executionStore.read(flowKey(degradedExecutionId)),
    ).resolves.toEqual(validFlowRecord);

    // An unmapped stream owns no execution: it is failed in-transcript
    // only, with no execution-store writes.
    expect(session.status.get(unmappedStreamId)).toBe(STREAM_PHASE.FAILED);
    expectClosedWith(transcripts, unmappedStreamId, RUN_OUTCOME.FAILED);
  });

  it('replaces stores with evictAll + bounded preload at the workspace-root boundary', async () => {
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const reload = vi.spyOn(transcripts, 'reload').mockResolvedValue();
    const preloadSnapshots = vi.spyOn(session.snapshots, 'preload');
    const evictSnapshots = vi.spyOn(session.snapshots, 'evictAll');
    const loadSnapshots = vi.spyOn(session.snapshots, 'load');
    session.status.transition(
      'previous-workspace' as StreamTabId,
      STREAM_PHASE.RUNNING,
      'lifecycle',
    );

    await session.reloadAfterStorageRootChange();

    expect(reload).toHaveBeenCalledOnce();
    expect(evictSnapshots).toHaveBeenCalledOnce();
    expect(preloadSnapshots).toHaveBeenCalledWith([]);
    expect(loadSnapshots).not.toHaveBeenCalled();
    expect(
      session.status.get('previous-workspace' as StreamTabId),
    ).toBeUndefined();
  });

  it('waits for execution artifacts before replacing workspace stores', async () => {
    const liveExecutionId = 'workspace-live' as ExecutionId;
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    await acquireFreshExecutionLease(liveExecutionId);
    const reload = vi.spyOn(transcripts, 'reload').mockResolvedValue();

    try {
      const replacement = session.reloadAfterStorageRootChange();
      await Promise.resolve();

      expect(reload).not.toHaveBeenCalled();
      await completeOwnedExecutionLease(liveExecutionId);
      await replacement;

      expect(reload).toHaveBeenCalledOnce();
    } finally {
      await completeOwnedExecutionLease(liveExecutionId);
    }
  });

  it('keeps the old storage root pinned until execution artifacts finish', async () => {
    const liveExecutionId = 'workspace-root-pinned' as ExecutionId;
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const storage = platform().storage;
    let activeRoot = '/workspace/old-storage';
    vi.spyOn(storage, 'getStoragePath').mockImplementation(() => activeRoot);
    Object.assign(storage, {
      hasPendingWorkspaceStorageChange: () => true,
      commitWorkspaceStorageChange: () => {
        activeRoot = '/workspace/new-storage';
        return true;
      },
    });
    await acquireFreshExecutionLease(liveExecutionId);
    const reload = vi.spyOn(transcripts, 'reload').mockResolvedValue();

    try {
      const replacement = session.reloadAfterStorageRootChange();
      await Promise.resolve();

      expect(storage.getStoragePath()).toBe('/workspace/old-storage');
      expect(reload).not.toHaveBeenCalled();

      await completeOwnedExecutionLease(liveExecutionId);
      await replacement;

      expect(storage.getStoragePath()).toBe('/workspace/new-storage');
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      await completeOwnedExecutionLease(liveExecutionId);
    }
  });

  it('flushes old-root stores before committing the new storage root', async () => {
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const storage = platform().storage;
    const order: string[] = [];
    Object.assign(storage, {
      hasPendingWorkspaceStorageChange: () => true,
      commitWorkspaceStorageChange: () => {
        order.push('commit');
        return true;
      },
    });
    vi.spyOn(transcripts, 'flush').mockImplementation(async () => {
      order.push('transcripts.flush');
    });
    vi.spyOn(session.snapshots, 'flush').mockImplementation(async () => {
      order.push('snapshots.flush');
    });
    vi.spyOn(transcripts, 'reload').mockImplementation(async () => {
      order.push('transcripts.reload');
    });

    await session.reloadAfterStorageRootChange();

    expect(order.indexOf('transcripts.flush')).toBeLessThan(
      order.indexOf('commit'),
    );
    expect(order.indexOf('snapshots.flush')).toBeLessThan(
      order.indexOf('commit'),
    );
    expect(order.indexOf('commit')).toBeLessThan(
      order.indexOf('transcripts.reload'),
    );
  });

  it('does not commit a new root when the old transcript flush fails', async () => {
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const commitWorkspaceStorageChange = mockPendingWorkspaceChange();
    const flushError = new Error('old transcript writes remain unresolved');
    vi.spyOn(transcripts, 'flush').mockRejectedValue(flushError);
    const reload = vi.spyOn(transcripts, 'reload');

    await expect(session.reloadAfterStorageRootChange()).rejects.toBe(
      flushError,
    );

    expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not commit a new root after disposal during the old-root flush', async () => {
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const commitWorkspaceStorageChange = mockPendingWorkspaceChange();
    let finishFlush: (() => void) | undefined;
    const flushBlocked = new Promise<void>((resolve) => {
      finishFlush = resolve;
    });
    vi.spyOn(transcripts, 'flush').mockReturnValue(flushBlocked);

    const replacement = session.reloadAfterStorageRootChange();
    await vi.waitFor(() => {
      expect(transcripts.flush).toHaveBeenCalledOnce();
    });

    session.dispose();
    finishFlush?.();

    await expect(replacement).resolves.toBe(false);
    expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();
  });

  it('rolls back a failed new-root load and permits retry', async () => {
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const storage = platform().storage;
    let activeRoot = '/workspace/old-storage';
    const finalizeWorkspaceStorageChange = vi.fn();
    const rollbackWorkspaceStorageChange = vi.fn(() => {
      activeRoot = '/workspace/old-storage';
      return true;
    });
    Object.assign(storage, {
      getStoragePath: () => activeRoot,
      hasPendingWorkspaceStorageChange: () =>
        activeRoot === '/workspace/old-storage',
      commitWorkspaceStorageChange: () => {
        activeRoot = '/workspace/new-storage';
        return true;
      },
      finalizeWorkspaceStorageChange,
      rollbackWorkspaceStorageChange,
    });
    const reload = vi.spyOn(transcripts, 'reload').mockResolvedValue();
    const reloadError = new Error('new snapshot root is unreadable');
    vi.spyOn(session.snapshots, 'preload')
      .mockRejectedValueOnce(reloadError)
      .mockResolvedValue();
    const evictSnapshots = vi.spyOn(session.snapshots, 'evictAll');
    session.status.transition(
      'old-workspace-running' as StreamTabId,
      STREAM_PHASE.RUNNING,
      'lifecycle',
    );
    const transitionHooks = {
      workspacePath: '/workspace/new',
      afterStorageCommit: vi.fn(async () => {}),
      afterStorageRollback: vi.fn(),
      afterStorageFinalize: vi.fn(),
    };

    await expect(
      session.reloadAfterStorageRootChange(transitionHooks),
    ).rejects.toBe(reloadError);

    expect(activeRoot).toBe('/workspace/old-storage');
    expect(rollbackWorkspaceStorageChange).toHaveBeenCalledOnce();
    expect(transitionHooks.afterStorageCommit).toHaveBeenCalledOnce();
    expect(transitionHooks.afterStorageRollback).toHaveBeenCalledOnce();
    expect(transitionHooks.afterStorageFinalize).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(evictSnapshots).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenNthCalledWith(2, {
      discardPendingWrites: true,
    });
    expect(session.status.get('old-workspace-running' as StreamTabId)).toBe(
      STREAM_PHASE.RUNNING,
    );

    await expect(
      session.reloadAfterStorageRootChange(transitionHooks),
    ).resolves.toBe(true);
    expect(activeRoot).toBe('/workspace/new-storage');
    expect(finalizeWorkspaceStorageChange).toHaveBeenCalledOnce();
    expect(transitionHooks.afterStorageCommit).toHaveBeenCalledTimes(2);
    expect(transitionHooks.afterStorageRollback).toHaveBeenCalledOnce();
    expect(transitionHooks.afterStorageFinalize).toHaveBeenCalledOnce();
  });

  it('restores delayed lease repair after a root replacement rolls back', async () => {
    vi.useFakeTimers({
      now: new Date('2026-07-28T12:00:00.000Z'),
    });
    const rollbackExecutionId = '9355abcd' as ExecutionId;
    const rollbackStreamId = `crashed#${rollbackExecutionId}` as StreamTabId;
    const storage = platform().storage;
    let activeRoot = 'old';
    Object.assign(storage, {
      hasPendingWorkspaceStorageChange: () => true,
      commitWorkspaceStorageChange: () => {
        activeRoot = 'new';
        return true;
      },
      rollbackWorkspaceStorageChange: () => {
        activeRoot = 'old';
        return true;
      },
    });
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(
      transcripts,
      rollbackStreamId,
      'rollback-running-group',
      Date.now(),
    );
    await transcripts.flush();
    await seedSidecarFk(rollbackStreamId, rollbackExecutionId);
    const executionStore = getExecutionStore(rollbackExecutionId);
    await executionStore.writeMeta({
      timestamp: new Date().toISOString(),
    });
    await executionStore.write(flowKey(rollbackExecutionId), {
      invalid: true,
    });
    await writeForeignLease(rollbackExecutionId);

    const session = openDeferredSession(transcripts);

    try {
      await session.waitUntilReady();
      expect(session.status.get(rollbackStreamId)).toBe(STREAM_PHASE.RUNNING);

      const replacementError = new Error('new snapshot root is unreadable');
      vi.spyOn(transcripts, 'reload').mockResolvedValue();
      vi.spyOn(session.snapshots, 'preload')
        .mockRejectedValueOnce(replacementError)
        .mockResolvedValue();

      await expect(session.reloadAfterStorageRootChange()).rejects.toBe(
        replacementError,
      );
      expect(activeRoot).toBe('old');
      expect(session.status.get(rollbackStreamId)).toBe(STREAM_PHASE.RUNNING);

      await vi.advanceTimersByTimeAsync(EXECUTION_LEASE_STALE_MS + 1);
      await vi.waitFor(() => {
        expect(session.status.get(rollbackStreamId)).toBe(STREAM_PHASE.FAILED);
      });

      await expect(executionStore.readMeta()).resolves.toMatchObject({
        outcome: RUN_OUTCOME.FAILED,
      });
      expectClosedWith(transcripts, rollbackStreamId, RUN_OUTCOME.FAILED);
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it('skips replacement when the workspace storage root is unchanged', async () => {
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const commitWorkspaceStorageChange = mockPendingWorkspaceChange({
      pending: false,
      commit: false,
    });
    const reload = vi.spyOn(transcripts, 'reload').mockResolvedValue();

    await session.reloadAfterStorageRootChange();

    expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not resume a root replacement after session disposal', async () => {
    const liveExecutionId = 'workspace-disposed' as ExecutionId;
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const commitWorkspaceStorageChange = mockPendingWorkspaceChange();
    await acquireFreshExecutionLease(liveExecutionId);

    try {
      const replacement = session.reloadAfterStorageRootChange();
      await Promise.resolve();
      expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();

      session.dispose();
      await completeOwnedExecutionLease(liveExecutionId);

      await expect(replacement).resolves.toBe(false);
      expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();
    } finally {
      await completeOwnedExecutionLease(liveExecutionId);
    }
  });

  it('holds new root executions outside the workspace replacement', async () => {
    const queuedExecutionId = 'workspace-queued' as ExecutionId;
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    let finishReload: (() => void) | undefined;
    const reloadBlocked = new Promise<void>((resolve) => {
      finishReload = resolve;
    });
    vi.spyOn(transcripts, 'reload').mockReturnValue(reloadBlocked);

    try {
      const replacement = session.reloadAfterStorageRootChange();
      await Promise.resolve();
      const acquisition = acquireFreshExecutionLease(queuedExecutionId);
      let acquired = false;
      void acquisition.then(() => {
        acquired = true;
      });
      await Promise.resolve();

      expect(acquired).toBe(false);
      finishReload?.();
      await replacement;
      await acquisition;

      expect(acquired).toBe(true);
    } finally {
      await completeOwnedExecutionLease(queuedExecutionId);
    }
  });

  it('surfaces a repair write failure at the readiness boundary', async () => {
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, streamId, 'failing-running-group');
    const repairError = new Error('restart repair write failed');
    vi.spyOn(transcripts, 'endRunningGroupsForStreams').mockRejectedValue(
      repairError,
    );

    const session = openDeferredSession(transcripts);
    await expect(session.waitUntilReady()).rejects.toBe(repairError);
  });
});
