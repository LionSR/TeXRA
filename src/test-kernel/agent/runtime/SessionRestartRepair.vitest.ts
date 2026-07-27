import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { flowKey } from '@agent/node/persistedFlow';
import {
  acquireFreshExecutionLease,
  completeOwnedExecutionLease,
  EXECUTION_LEASE_STALE_MS,
  resetExecutionLeaseCoordinationForTests,
} from '@agent/storage/executionLease';
import * as waitingDetection from '@agent/storage/detectWaitingStreams';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { platform } from '@platform/platform';
import {
  EXECUTION_STATUS,
  LOG_LEVELS,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { StreamLogStore } from '@transcript';
import { StorageFS } from '@utils/files';

setupPlatform({ workspacePath: '/workspace/session-restart-repair' });

const executionId = 'abc123' as ExecutionId;
const streamId = `crashed#${executionId}` as StreamTabId;
const validFlowRecord = {
  flowName: 'texra',
  shared: { messages: [] },
  createdAt: '2026-07-26T00:00:00.000Z',
  nodes: [],
};

afterEach(async () => {
  vi.restoreAllMocks();
  await StorageFS.delete('executionLeases', { recursive: true }).catch(
    () => undefined,
  );
  await StorageFS.delete('executions', { recursive: true }).catch(
    () => undefined,
  );
  await StorageFS.delete('streamLogs', { recursive: true }).catch(
    () => undefined,
  );
  await StorageFS.delete('streamLogSummaries', { recursive: true }).catch(
    () => undefined,
  );
  clearStoreCache();
  resetExecutionLeaseCoordinationForTests();
});

describe('SessionHandle restart repair', () => {
  it('stops in-flight restart repair when the session is disposed', async () => {
    const transcripts = await StreamLogStore.open();
    transcripts.append(streamId, {
      id: 'disposed-running-group',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1_000,
      data: { status: STREAM_PHASE.RUNNING },
    });
    await transcripts.flush();

    let finishDetection: ((streams: Set<StreamTabId>) => void) | undefined;
    const detectionBlocked = new Promise<Set<StreamTabId>>((resolve) => {
      finishDetection = resolve;
    });
    vi.spyOn(waitingDetection, 'detectWaitingStreams').mockReturnValue(
      detectionBlocked,
    );

    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
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
    transcripts.append(streamId, {
      id: 'crashed-running-group',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1_000,
      data: { status: STREAM_PHASE.RUNNING },
    });
    await transcripts.flush();

    const executionStore = getExecutionStore(executionId);
    await executionStore.writeMeta({
      timestamp: '2026-07-26T00:00:00.000Z',
    });
    await executionStore.write(flowKey(executionId), { invalid: true });

    const heartbeatAt = Date.now() - EXECUTION_LEASE_STALE_MS - 1;
    await StorageFS.ensureDir('executionLeases');
    await StorageFS.writeAtomic(
      `executionLeases/${executionId}.json`,
      JSON.stringify({
        version: 1,
        executionId,
        ownerToken: '00000000-0000-4000-8000-000000000001',
        acquiredAt: heartbeatAt,
        heartbeatAt,
      }),
    );

    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    try {
      await session.waitUntilReady();

      expect(session.status.get(streamId)).toBe(STREAM_PHASE.FAILED);
      await expect(executionStore.readMeta()).resolves.toMatchObject({
        terminalStatus: EXECUTION_STATUS.ERROR,
      });
      await expect(
        executionStore.read(flowKey(executionId)),
      ).resolves.toBeUndefined();
      expect(transcripts.get(streamId)?.getRange(0).at(-1)).toMatchObject({
        type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
        data: { status: 'failed' },
      });
    } finally {
      session.dispose();
    }
  });

  it('preserves recovery state when present execution metadata is malformed', async () => {
    const transcripts = await StreamLogStore.open();
    transcripts.append(streamId, {
      id: 'malformed-meta-running-group',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1_000,
      data: { status: STREAM_PHASE.RUNNING },
    });
    await transcripts.flush();

    const executionStore = getExecutionStore(executionId);
    const malformedMeta = { timestamp: 123 };
    await executionStore.write('meta', malformedMeta);
    await executionStore.write(flowKey(executionId), validFlowRecord);

    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    try {
      await expect(session.waitUntilReady()).rejects.toThrow();

      await expect(executionStore.read('meta')).resolves.toEqual(malformedMeta);
      await expect(executionStore.read(flowKey(executionId))).resolves.toEqual(
        validFlowRecord,
      );
      expect(transcripts.get(streamId)?.getRange(0)).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });

  it('ignores malformed metadata for settled historical streams', async () => {
    const transcripts = await StreamLogStore.open();
    transcripts.append(streamId, {
      id: 'settled-history-running-group',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1_000,
      data: { status: STREAM_PHASE.RUNNING },
    });
    await transcripts.endRunningGroupsForStreams(
      [streamId],
      2_000,
      RUN_OUTCOME.COMPLETED,
    );
    await transcripts.flush();
    const executionStore = getExecutionStore(executionId);
    const malformedMeta = { timestamp: null };
    await executionStore.write('meta', malformedMeta);

    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    try {
      await expect(session.waitUntilReady()).resolves.toBeUndefined();
      await expect(executionStore.read('meta')).resolves.toEqual(malformedMeta);
    } finally {
      session.dispose();
    }
  });

  it('closes an orphaned group without rewriting its completed execution', async () => {
    const completedExecutionId = 'c0ffee123' as ExecutionId;
    const completedStreamId =
      `completed#${completedExecutionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    transcripts.append(completedStreamId, {
      id: 'completed-running-group',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1_000,
      data: { status: STREAM_PHASE.RUNNING },
    });
    await transcripts.flush();

    const executionStore = getExecutionStore(completedExecutionId);
    await executionStore.writeMeta({
      timestamp: '2026-07-26T00:00:00.000Z',
      terminalStatus: EXECUTION_STATUS.COMPLETED,
    });

    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    try {
      await session.waitUntilReady();

      expect(session.status.get(completedStreamId)).toBe(
        STREAM_PHASE.COMPLETED,
      );
      await expect(executionStore.readMeta()).resolves.toMatchObject({
        terminalStatus: EXECUTION_STATUS.COMPLETED,
      });
      expect(
        transcripts.get(completedStreamId)?.getRange(0).at(-1),
      ).toMatchObject({
        type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
        data: { status: RUN_OUTCOME.COMPLETED },
      });
    } finally {
      session.dispose();
    }
  });

  it('detects a resumable run from its canonical stream suffix', async () => {
    const resumableExecutionId = 'facade123' as ExecutionId;
    const resumableStreamId =
      `resumable#${resumableExecutionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    transcripts.append(resumableStreamId, {
      id: 'resumable-running-group',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1_000,
      data: { status: STREAM_PHASE.RUNNING },
    });
    await transcripts.flush();

    const executionStore = getExecutionStore(resumableExecutionId);
    await executionStore.writeMeta({
      timestamp: '2026-07-26T00:00:00.000Z',
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
    });
    await executionStore.write(flowKey(resumableExecutionId), validFlowRecord);

    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    try {
      await session.waitUntilReady();

      expect(
        session.snapshots.getExecutionId(resumableStreamId),
      ).toBeUndefined();
      expect(session.status.get(resumableStreamId)).toBe(STREAM_PHASE.WAITING);
      await expect(
        executionStore.read(flowKey(resumableExecutionId)),
      ).resolves.toEqual(validFlowRecord);
      expect(
        transcripts.get(resumableStreamId)?.getRange(0).at(-1),
      ).toMatchObject({
        type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
        data: { status: RUN_OUTCOME.CANCELLED },
      });
    } finally {
      session.dispose();
    }
  });

  it('fails a suffix-only crashed run when resumability detection fails', async () => {
    const degradedExecutionId = 'decade123' as ExecutionId;
    const degradedStreamId = `degraded#${degradedExecutionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    transcripts.append(degradedStreamId, {
      id: 'degraded-running-group',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1_000,
      data: { status: STREAM_PHASE.RUNNING },
    });
    await transcripts.flush();

    const executionStore = getExecutionStore(degradedExecutionId);
    await executionStore.writeMeta({
      timestamp: '2026-07-26T00:00:00.000Z',
    });
    await executionStore.write(flowKey(degradedExecutionId), validFlowRecord);
    vi.spyOn(waitingDetection, 'detectWaitingStreams').mockRejectedValueOnce(
      new Error('resumability read failed'),
    );

    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    try {
      await session.waitUntilReady();

      expect(
        session.snapshots.getExecutionId(degradedStreamId),
      ).toBeUndefined();
      expect(session.status.get(degradedStreamId)).toBe(STREAM_PHASE.FAILED);
      await expect(
        executionStore.read(flowKey(degradedExecutionId)),
      ).resolves.toBeUndefined();
      expect(
        transcripts.get(degradedStreamId)?.getRange(0).at(-1),
      ).toMatchObject({
        type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
        data: { status: RUN_OUTCOME.FAILED },
      });
    } finally {
      session.dispose();
    }
  });

  it('replaces stores and status only at the workspace-root boundary', async () => {
    const transcripts = await StreamLogStore.open();
    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    const reload = vi.spyOn(transcripts, 'reload').mockResolvedValue();
    const loadSnapshots = vi.spyOn(session.snapshots, 'load');
    session.status.transition(
      'previous-workspace' as StreamTabId,
      STREAM_PHASE.RUNNING,
      'lifecycle',
    );

    try {
      await session.reloadAfterStorageRootChange();

      expect(reload).toHaveBeenCalledOnce();
      expect(loadSnapshots).toHaveBeenCalledWith(transcripts.keys());
      expect(
        session.status.get('previous-workspace' as StreamTabId),
      ).toBeUndefined();
    } finally {
      session.dispose();
    }
  });

  it('waits for execution artifacts before replacing workspace stores', async () => {
    const liveExecutionId = 'workspace-live' as ExecutionId;
    const transcripts = await StreamLogStore.open();
    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
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
      session.dispose();
    }
  });

  it('keeps the old storage root pinned until execution artifacts finish', async () => {
    const liveExecutionId = 'workspace-root-pinned' as ExecutionId;
    const transcripts = await StreamLogStore.open();
    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
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
      session.dispose();
    }
  });

  it('flushes old-root stores before committing the new storage root', async () => {
    const transcripts = await StreamLogStore.open();
    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
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

    try {
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
    } finally {
      session.dispose();
    }
  });

  it('does not commit a new root when the old transcript flush fails', async () => {
    const transcripts = await StreamLogStore.open();
    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    const storage = platform().storage;
    const commitWorkspaceStorageChange = vi.fn(() => true);
    Object.assign(storage, {
      hasPendingWorkspaceStorageChange: () => true,
      commitWorkspaceStorageChange,
    });
    const flushError = new Error('old transcript writes remain unresolved');
    vi.spyOn(transcripts, 'flush').mockRejectedValue(flushError);
    const reload = vi.spyOn(transcripts, 'reload');

    try {
      await expect(session.reloadAfterStorageRootChange()).rejects.toBe(
        flushError,
      );

      expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it('does not commit a new root after disposal during the old-root flush', async () => {
    const transcripts = await StreamLogStore.open();
    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    const commitWorkspaceStorageChange = vi.fn(() => true);
    Object.assign(platform().storage, {
      hasPendingWorkspaceStorageChange: () => true,
      commitWorkspaceStorageChange,
    });
    let finishFlush: (() => void) | undefined;
    const flushBlocked = new Promise<void>((resolve) => {
      finishFlush = resolve;
    });
    vi.spyOn(transcripts, 'flush').mockReturnValue(flushBlocked);

    try {
      const replacement = session.reloadAfterStorageRootChange();
      await vi.waitFor(() => {
        expect(transcripts.flush).toHaveBeenCalledOnce();
      });

      session.dispose();
      finishFlush?.();

      await expect(replacement).resolves.toBe(false);
      expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it('rolls back a failed new-root load and permits retry', async () => {
    const transcripts = await StreamLogStore.open();
    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
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
    vi.spyOn(session.snapshots, 'load')
      .mockRejectedValueOnce(reloadError)
      .mockResolvedValue();
    const evictSnapshots = vi.spyOn(session.snapshots, 'evictAll');
    session.status.transition(
      'old-workspace-running' as StreamTabId,
      STREAM_PHASE.RUNNING,
      'lifecycle',
    );

    try {
      await expect(session.reloadAfterStorageRootChange()).rejects.toBe(
        reloadError,
      );

      expect(activeRoot).toBe('/workspace/old-storage');
      expect(rollbackWorkspaceStorageChange).toHaveBeenCalledOnce();
      expect(reload).toHaveBeenCalledTimes(2);
      expect(evictSnapshots).toHaveBeenCalledOnce();
      expect(reload).toHaveBeenNthCalledWith(2, {
        discardPendingWrites: true,
      });
      expect(session.status.get('old-workspace-running' as StreamTabId)).toBe(
        STREAM_PHASE.RUNNING,
      );

      await expect(session.reloadAfterStorageRootChange()).resolves.toBe(true);
      expect(activeRoot).toBe('/workspace/new-storage');
      expect(finalizeWorkspaceStorageChange).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
    }
  });

  it('skips replacement when the workspace storage root is unchanged', async () => {
    const transcripts = await StreamLogStore.open();
    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    const storage = platform().storage;
    const commitWorkspaceStorageChange = vi.fn(() => false);
    Object.assign(storage, {
      hasPendingWorkspaceStorageChange: () => false,
      commitWorkspaceStorageChange,
    });
    const reload = vi.spyOn(transcripts, 'reload').mockResolvedValue();

    try {
      await session.reloadAfterStorageRootChange();

      expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it('does not resume a root replacement after session disposal', async () => {
    const liveExecutionId = 'workspace-disposed' as ExecutionId;
    const transcripts = await StreamLogStore.open();
    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    const commitWorkspaceStorageChange = vi.fn(() => true);
    Object.assign(platform().storage, {
      hasPendingWorkspaceStorageChange: () => true,
      commitWorkspaceStorageChange,
    });
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
      session.dispose();
    }
  });

  it('holds new root executions outside the workspace replacement', async () => {
    const queuedExecutionId = 'workspace-queued' as ExecutionId;
    const transcripts = await StreamLogStore.open();
    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
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
      session.dispose();
    }
  });

  it('surfaces a repair write failure at the readiness boundary', async () => {
    const transcripts = await StreamLogStore.open();
    transcripts.append(streamId, {
      id: 'failing-running-group',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1_000,
      data: { status: STREAM_PHASE.RUNNING },
    });
    const repairError = new Error('restart repair write failed');
    vi.spyOn(transcripts, 'endRunningGroupsForStreams').mockRejectedValue(
      repairError,
    );

    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    try {
      await expect(session.waitUntilReady()).rejects.toBe(repairError);
    } finally {
      session.dispose();
    }
  });
});
