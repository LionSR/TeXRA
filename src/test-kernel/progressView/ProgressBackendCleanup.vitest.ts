/**
 * Durable cleanup: what clearing one stream or every stream deletes on disk,
 * what it retains when an execution is still active or a step fails, and how a
 * staged deletion finishes after a crash.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

import * as path from 'node:path';

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

import { getExecutionStore } from '@agent/storage';
import * as logger from '@logger/logUtils';
import { type ExecutionId, type StreamTabId } from '@shared/schemas';
import {
  executionLeasePath,
  writeForeignLease,
} from '@test/support/executionLeaseFixtures';
import { snapshotFacts } from '@test/support/storeTestDrivers';
import { GoalStore } from '@tools/goal';
import { streamDataDir, StreamSnapshotStore } from '@transcript';
import {
  stagedStreamDataDir,
  STREAM_DATA_DIR,
} from '@transcript/streamDataPaths';
import { StorageFS } from '@utils/files';

import {
  createIsolatedRecordingBackend,
  createPersistentRecordingBackend,
  executionDeleter,
  toolUseConfig,
  writeExecutionConfig,
} from './progressBackendHarness';

describe('ProgressBackend', () => {
  it('deletes the execution directory named by stream metadata when a stream is cleared', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const stream = 'tool@deepseek#a6966a' as StreamTabId;
    const executionId = 'a6966a' as ExecutionId;

    try {
      await backend.state.snapshots.load([stream]);
      backend.state.streamLogs.ensureStream(stream);
      snapshotFacts(backend.state.snapshots).setRunConfig(
        stream,
        toolUseConfig('search', 'deepseekproT'),
        executionId,
      );
      await writeExecutionConfig(executionId);
      await backend.state.flush();
      await GoalStore.start(stream, 'finish the cleanup');

      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
      expect(await StorageFS.exists(streamDataDir(stream))).toBe(true);

      await backend.state.clearStream(stream);

      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(false);
      expect(await StorageFS.exists(streamDataDir(stream))).toBe(false);
      expect(GoalStore.getForStream(stream)).toBeNull();
    } finally {
      await GoalStore.forget(stream);
      await backend.state.clearAll();
    }
  });

  it('retains stream state and execution config when adjacent cleanup fails', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const stream = 'tool@deepseek#a6966f' as StreamTabId;
    const executionId = 'a6966f' as ExecutionId;
    const snapshotDeleteSpy = vi
      .spyOn(backend.state.snapshots, 'stageDeleteStream')
      .mockRejectedValueOnce(new Error('snapshot directory is locked'));

    try {
      backend.state.streamLogs.ensureStream(stream);
      snapshotFacts(backend.state.snapshots).setRunConfig(
        stream,
        toolUseConfig('search', 'deepseekproT'),
        executionId,
      );
      await writeExecutionConfig(executionId);
      await backend.state.flush();

      await expect(backend.state.clearStream(stream)).resolves.toBe('failed');

      expect(backend.state.streamLogs.has(stream)).toBe(true);
      expect(backend.state.snapshots.getExecutionId(stream)).toBe(executionId);
      expect(backend.state.snapshots.getRunConfig(stream)).toEqual(
        toolUseConfig('search', 'deepseekproT'),
      );
      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
    } finally {
      snapshotDeleteSpy.mockRestore();
      await backend.state.clearAll();
    }
  });

  it('commits stream deletion when only final execution cleanup fails', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const stream = 'tool@deepseek#a6966e' as StreamTabId;
    const executionId = 'a6966e' as ExecutionId;
    const deleteExecutionSpy = vi
      .spyOn(executionDeleter(backend), 'deleteExecution')
      .mockImplementation(async (_id, options) => {
        await options?.beforeDelete?.();
        throw new Error('execution directory is locked');
      });

    try {
      backend.state.streamLogs.ensureStream(stream);
      snapshotFacts(backend.state.snapshots).setRunConfig(
        stream,
        toolUseConfig('search', 'deepseekproT'),
        executionId,
      );
      await writeExecutionConfig(executionId);
      await backend.state.flush();

      await expect(backend.state.clearStream(stream)).resolves.toBe('deleted');

      expect(backend.state.streamLogs.has(stream)).toBe(false);
      expect(backend.state.snapshots.getRunConfig(stream)).toBeUndefined();
      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
    } finally {
      deleteExecutionSpy.mockRestore();
      await getExecutionStore(executionId).clear();
      await backend.state.clearAll();
    }
  });

  it('does not retain a stream after the transcript commit point', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const stream = 'tool@deepseek#a69660' as StreamTabId;
    const executionId = 'a69660' as ExecutionId;
    const forgetSpy = vi
      .spyOn(GoalStore, 'forget')
      .mockRejectedValueOnce(new Error('goal state is locked'));

    try {
      backend.state.streamLogs.ensureStream(stream);
      snapshotFacts(backend.state.snapshots).setRunConfig(
        stream,
        toolUseConfig('search', 'deepseekproT'),
        executionId,
      );
      await writeExecutionConfig(executionId);
      await backend.state.flush();

      await expect(backend.state.clearStream(stream)).resolves.toBe('deleted');

      expect(backend.state.streamLogs.has(stream)).toBe(false);
      expect(await StorageFS.exists(streamDataDir(stream))).toBe(false);
      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(false);
    } finally {
      forgetSpy.mockRestore();
      await backend.state.clearAll();
    }
  });

  it('retains execution sidecars and goals for an externally active run', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const stream = 'tool@deepseek#a6966b' as StreamTabId;
    const executionId = 'a6966b' as ExecutionId;

    try {
      await backend.state.snapshots.load([stream]);
      backend.state.streamLogs.ensureStream(stream);
      snapshotFacts(backend.state.snapshots).setRunConfig(
        stream,
        toolUseConfig('search', 'deepseekproT'),
        executionId,
      );
      await writeExecutionConfig(executionId);
      await backend.state.flush();
      await GoalStore.start(stream, 'preserve the active execution');
      await writeForeignLease(executionId);

      await backend.state.clearStream(stream);

      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
      expect(await StorageFS.exists(streamDataDir(stream))).toBe(true);
      expect(GoalStore.getForStream(stream)).not.toBeNull();
    } finally {
      await StorageFS.delete(executionLeasePath(executionId)).catch(() => {});
      await GoalStore.forget(stream);
      await getExecutionStore(executionId).clear();
      await backend.state.clearAll();
    }
  });

  it('derives an active execution from the stream id when snapshot mapping is absent', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const stream = 'tool@deepseek#a6966c' as StreamTabId;
    const executionId = 'a6966c' as ExecutionId;

    try {
      await backend.state.snapshots.load([stream]);
      backend.state.streamLogs.ensureStream(stream);
      await writeExecutionConfig(executionId);
      await backend.state.flush();
      await StorageFS.ensureDir(streamDataDir(stream));
      await GoalStore.start(stream, 'preserve the unmapped active execution');
      await writeForeignLease(executionId);

      await backend.state.clearStream(stream);

      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
      expect(await StorageFS.exists(streamDataDir(stream))).toBe(true);
      expect(GoalStore.getForStream(stream)).not.toBeNull();
    } finally {
      await StorageFS.delete(executionLeasePath(executionId)).catch(() => {});
      await GoalStore.forget(stream);
      await getExecutionStore(executionId).clear();
      await backend.state.clearAll();
    }
  });

  it('retains a log-only stream during bulk cleanup when its execution is active', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const stream = 'tool@deepseek#a6966d' as StreamTabId;
    const executionId = 'a6966d' as ExecutionId;

    try {
      backend.state.streamLogs.ensureStream(stream);
      await writeExecutionConfig(executionId);
      await GoalStore.start(stream, 'preserve the log-only active execution');
      await writeForeignLease(executionId);

      const retained = await backend.state.clearAll();

      expect(retained).toEqual({
        active: new Set([stream]),
        failed: new Set(),
      });
      expect(backend.state.streamLogs.has(stream)).toBe(true);
      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
      expect(GoalStore.getForStream(stream)).not.toBeNull();
    } finally {
      await StorageFS.delete(executionLeasePath(executionId)).catch(() => {});
      await GoalStore.forget(stream);
      await getExecutionStore(executionId).clear();
      await backend.state.clearAll();
    }
  });

  it('serializes bulk cleanup behind an existing staged deletion', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const stream = 'tool@deepseek#a6966e' as StreamTabId;
    const executionId = 'a6966e' as ExecutionId;
    let stagedDeletion:
      | Awaited<ReturnType<typeof backend.state.snapshots.stageDeleteStream>>
      | undefined;

    try {
      await backend.state.snapshots.load([stream]);
      backend.state.streamLogs.ensureStream(stream);
      snapshotFacts(backend.state.snapshots).setRunConfig(
        stream,
        toolUseConfig('search', 'deepseekproT'),
        executionId,
      );
      await writeExecutionConfig(executionId);
      await backend.state.flush();
      stagedDeletion = await backend.state.snapshots.stageDeleteStream(stream);

      const cleanup = backend.state.clearAll();
      await stagedDeletion.rollback();
      stagedDeletion = undefined;
      const retained = await cleanup;

      expect(retained).toEqual({
        active: new Set(),
        failed: new Set(),
      });
      expect(backend.state.streamLogs.has(stream)).toBe(false);
      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(false);
    } finally {
      await stagedDeletion?.rollback();
      await getExecutionStore(executionId).clear();
      await backend.state.clearAll();
    }
  });

  it('reconciles required cleanup and final execution cleanup independently', async () => {
    const failedStream = 'tool@deepseek#fa11ed6966' as StreamTabId;
    const incompleteStream = 'tool@deepseek#faded6966' as StreamTabId;
    const deletedStream = 'tool@deepseek#de1e7ed6966' as StreamTabId;
    const failedExecution = 'fa11ed6966' as ExecutionId;
    const incompleteExecution = 'faded6966' as ExecutionId;
    const deletedExecution = 'de1e7ed6966' as ExecutionId;
    const { backend } = createIsolatedRecordingBackend();
    backend.state.streamLogs.ensureStream(failedStream);
    backend.state.streamLogs.ensureStream(incompleteStream);
    backend.state.streamLogs.ensureStream(deletedStream);
    snapshotFacts(backend.state.snapshots).setRunConfig(
      failedStream,
      toolUseConfig('search', 'deepseekproT'),
      failedExecution,
    );
    snapshotFacts(backend.state.snapshots).setRunConfig(
      incompleteStream,
      toolUseConfig('search', 'deepseekproT'),
      incompleteExecution,
    );
    snapshotFacts(backend.state.snapshots).setRunConfig(
      deletedStream,
      toolUseConfig('search', 'deepseekproT'),
      deletedExecution,
    );
    const deleteExecutionSpy = vi
      .spyOn(executionDeleter(backend), 'deleteExecution')
      .mockImplementation(async (executionId, options) => {
        if (executionId === failedExecution) {
          throw new Error('execution directory is locked');
        }
        await options?.beforeDelete?.();
        if (executionId === incompleteExecution) {
          throw new Error('execution directory is locked');
        }
        return { status: 'deleted', executionId };
      });

    try {
      const result = await backend.state.clearAll();

      expect(result).toEqual({
        active: new Set(),
        failed: new Set([failedStream]),
      });
      expect(backend.state.streamLogs.has(failedStream)).toBe(true);
      expect(backend.state.streamLogs.has(incompleteStream)).toBe(false);
      expect(backend.state.streamLogs.has(deletedStream)).toBe(false);
    } finally {
      deleteExecutionSpy.mockRestore();
      await backend.state.clearAll();
    }
  });

  it('does not retain bulk-deleted streams after the transcript commit point', async () => {
    const stream = 'tool@deepseek#b69660' as StreamTabId;
    const executionId = 'b69660' as ExecutionId;
    const { backend } = createIsolatedRecordingBackend();
    backend.state.streamLogs.ensureStream(stream);
    snapshotFacts(backend.state.snapshots).setRunConfig(
      stream,
      toolUseConfig('search', 'deepseekproT'),
      executionId,
    );
    await writeExecutionConfig(executionId);
    const forgetManySpy = vi
      .spyOn(GoalStore, 'forgetMany')
      .mockRejectedValueOnce(new Error('goal index is locked'));

    try {
      await expect(backend.state.clearAll()).resolves.toEqual({
        active: new Set(),
        failed: new Set(),
      });

      expect(backend.state.streamLogs.has(stream)).toBe(false);
      expect(await StorageFS.exists(streamDataDir(stream))).toBe(false);
      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(false);
    } finally {
      forgetManySpy.mockRestore();
      await backend.state.clearAll();
    }
  });

  it('tracks transcript cleanup failures per stream within one execution', async () => {
    const failedStream = 'restored-override-stream' as StreamTabId;
    const deletedStream = 'workflow@deepseek#f00baa6966' as StreamTabId;
    const executionId = 'f00baa6966' as ExecutionId;
    const { backend } = createIsolatedRecordingBackend();
    backend.state.streamLogs.ensureStream(failedStream);
    backend.state.streamLogs.ensureStream(deletedStream);
    snapshotFacts(backend.state.snapshots).setRunConfig(
      failedStream,
      toolUseConfig('search', 'deepseekproT'),
      executionId,
    );
    snapshotFacts(backend.state.snapshots).setRunConfig(
      deletedStream,
      toolUseConfig('search', 'deepseekproT'),
      executionId,
    );
    await writeExecutionConfig(executionId);
    const deleteTranscript = backend.state.streamLogs.delete.bind(
      backend.state.streamLogs,
    );
    const deleteTranscriptSpy = vi
      .spyOn(backend.state.streamLogs, 'delete')
      .mockImplementation(async (stream) => {
        if (stream === failedStream) {
          throw new Error('transcript directory is locked');
        }
        await deleteTranscript(stream);
      });

    try {
      const result = await backend.state.clearAll();

      expect(result).toEqual({
        active: new Set(),
        failed: new Set([failedStream]),
      });
      expect(backend.state.streamLogs.has(failedStream)).toBe(true);
      expect(backend.state.streamLogs.has(deletedStream)).toBe(false);
      expect(backend.state.snapshots.getExecutionId(failedStream)).toBe(
        executionId,
      );
      expect(await StorageFS.exists(streamDataDir(failedStream))).toBe(true);
      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);

      deleteTranscriptSpy.mockRestore();
      await expect(backend.state.clearStream(failedStream)).resolves.toBe(
        'deleted',
      );
      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(false);
    } finally {
      deleteTranscriptSpy.mockRestore();
      await backend.state.clearAll();
    }
  });

  it('forgets goal entries when clearing never-registered streams', async () => {
    const stream = 'tool@deepseek#missing' as StreamTabId;
    const { backend } = createIsolatedRecordingBackend();

    try {
      await GoalStore.start(stream, 'forget this unregistered goal');

      await backend.state.clearStream(stream);

      expect(GoalStore.getForStream(stream)).toBeNull();
    } finally {
      await GoalStore.forget(stream);
      await backend.state.clearAll();
    }
  });

  it('clearStream refuses reserved stream ids before durable store cleanup', async () => {
    const sentinel = path.join(STREAM_DATA_DIR, 'sentinel.json');
    await StorageFS.ensureDir(STREAM_DATA_DIR);
    await StorageFS.write(sentinel, '{}');

    const { backend } = createIsolatedRecordingBackend();
    try {
      await backend.state.clearStream('' as StreamTabId);
      await backend.state.clearStream('.' as StreamTabId);
      await backend.state.clearStream('..' as StreamTabId);

      expect(await StorageFS.exists(sentinel)).toBe(true);
    } finally {
      await backend.state.clearAll();
    }
  });

  it('forgets goal entries when clearing all streams', async () => {
    const stream = 'tool@deepseek#b6966b' as StreamTabId;
    const { backend } = createIsolatedRecordingBackend();

    try {
      backend.state.streamLogs.ensureStream(stream);
      await GoalStore.start(stream, 'clear this goal');

      await backend.state.clearAll();

      expect(GoalStore.getForStream(stream)).toBeNull();
    } finally {
      await GoalStore.forget(stream);
      await backend.state.clearAll();
    }
  });

  it('sweeps streamData orphans without deleting standalone execution history', async () => {
    const orphanStream = 'tool@deepseek#b6966b' as StreamTabId;
    const orphanExecution = 'b6966b' as ExecutionId;
    const historyExecution = 'c6966c' as ExecutionId;

    const { backend } = await createPersistentRecordingBackend();
    try {
      const seed = new StreamSnapshotStore();
      await seed.load([orphanStream]);
      snapshotFacts(seed).setRunConfig(
        orphanStream,
        toolUseConfig('search', 'deepseekproT'),
        orphanExecution,
      );
      await writeExecutionConfig(orphanExecution);
      await writeExecutionConfig(historyExecution);
      await seed.flush();
      await GoalStore.start(orphanStream, 'sweep this orphan');

      expect(await StorageFS.exists(streamDataDir(orphanStream))).toBe(true);
      expect(await StorageFS.exists(`executions/${orphanExecution}`)).toBe(
        true,
      );
      expect(await StorageFS.exists(`executions/${historyExecution}`)).toBe(
        true,
      );

      await backend.state.load();

      expect(await StorageFS.exists(streamDataDir(orphanStream))).toBe(false);
      expect(await StorageFS.exists(`executions/${orphanExecution}`)).toBe(
        false,
      );
      expect(await StorageFS.exists(`executions/${historyExecution}`)).toBe(
        true,
      );
      expect(GoalStore.getForStream(orphanStream)).toBeNull();
    } finally {
      await GoalStore.forget(orphanStream);
      await getExecutionStore(historyExecution).clear();
      await backend.state.clearAll();
    }
  });

  it('finishes a staged deletion whose transcript committed before a crash', async () => {
    const stream = 'tool@deepseek#c69660' as StreamTabId;
    const executionId = 'c69660' as ExecutionId;
    const seed = new StreamSnapshotStore();
    await seed.load([]);
    snapshotFacts(seed).setRunConfig(
      stream,
      toolUseConfig('search', 'deepseekproT'),
      executionId,
    );
    await writeExecutionConfig(executionId);
    await seed.flush();
    await GoalStore.start(stream, 'finish this interrupted deletion');
    await seed.stageDeleteStream(stream);

    const { backend } = await createPersistentRecordingBackend();
    try {
      expect(await StorageFS.exists(streamDataDir(stream))).toBe(false);
      expect(await seed.listStagedDeletions()).toContain(stream);

      await backend.state.load();

      expect(await backend.state.snapshots.listStagedDeletions()).not.toContain(
        stream,
      );
      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(false);
      expect(GoalStore.getForStream(stream)).toBeNull();
    } finally {
      await GoalStore.forget(stream);
      await backend.state.clearAll();
    }
  });

  it('finishes committed staged residue without requiring a reload', async () => {
    const stream = 'tool@deepseek#c69661' as StreamTabId;
    const executionId = 'c69661' as ExecutionId;
    const { backend, session } = createIsolatedRecordingBackend();
    snapshotFacts(backend.state.snapshots).setRunConfig(
      stream,
      toolUseConfig('search', 'deepseekproT'),
      executionId,
    );
    await writeExecutionConfig(executionId);
    await backend.state.flush();
    await GoalStore.start(stream, 'finish same-session cleanup');
    const deletion = await backend.state.snapshots.stageDeleteStream(stream);
    const deleteStorage = StorageFS.delete.bind(StorageFS);
    const deleteSpy = vi
      .spyOn(StorageFS, 'delete')
      .mockImplementationOnce(async (target, options) => {
        if (target === stagedStreamDataDir(stream)) {
          throw new Error('staged snapshot directory is locked');
        }
        await deleteStorage(target, options);
      });

    try {
      await deletion.commit();
      deleteSpy.mockRestore();
      expect(await backend.state.snapshots.listStagedDeletions()).toContain(
        stream,
      );

      await backend.state.clearAll();

      expect(await backend.state.snapshots.listStagedDeletions()).not.toContain(
        stream,
      );
      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(false);
      expect(GoalStore.getForStream(stream)).toBeNull();
    } finally {
      deleteSpy.mockRestore();
      await GoalStore.forget(stream);
      await backend.state.clearAll();
    }
  });

  it('continues sweeping streamData orphans when one orphan cleanup fails', async () => {
    const failingStream = 'tool@deepseek#d6966d' as StreamTabId;
    const sweptStream = 'tool@deepseek#e6966e' as StreamTabId;
    const failingExecution = 'd6966d' as ExecutionId;
    const sweptExecution = 'e6966e' as ExecutionId;
    const seed = new StreamSnapshotStore();
    await seed.load([failingStream, sweptStream]);
    snapshotFacts(seed).setRunConfig(
      failingStream,
      toolUseConfig('search', 'deepseekproT'),
      failingExecution,
    );
    snapshotFacts(seed).setRunConfig(
      sweptStream,
      toolUseConfig('search', 'deepseekproT'),
      sweptExecution,
    );
    await writeExecutionConfig(failingExecution);
    await writeExecutionConfig(sweptExecution);
    await seed.flush();

    const { backend } = await createPersistentRecordingBackend();
    const originalStageDeleteStream =
      backend.state.snapshots.stageDeleteStream.bind(backend.state.snapshots);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const deleteSpy = vi
      .spyOn(backend.state.snapshots, 'stageDeleteStream')
      .mockImplementation(async (stream) => {
        if (stream === failingStream) {
          throw new Error('locked stream sidecar');
        }
        return originalStageDeleteStream(stream);
      });

    try {
      await expect(backend.state.load()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        'SessionStores',
        `Skipping orphaned execution cleanup for ${failingExecution}; startup will continue.`,
        { data: expect.any(Error) },
      );
      expect(await StorageFS.exists(streamDataDir(failingStream))).toBe(true);
      expect(await StorageFS.exists(`executions/${failingExecution}`)).toBe(
        true,
      );
      expect(await StorageFS.exists(streamDataDir(sweptStream))).toBe(false);
      expect(await StorageFS.exists(`executions/${sweptExecution}`)).toBe(
        false,
      );
    } finally {
      deleteSpy.mockRestore();
      warnSpy.mockRestore();
      await getExecutionStore(failingExecution).clear();
      await getExecutionStore(sweptExecution).clear();
      await backend.state.clearAll();
    }
  });

  it('continues sweeping streamData orphans when one execution cleanup fails', async () => {
    const failingStream = 'tool@deepseek#f6966f' as StreamTabId;
    const sweptStream = 'tool@deepseek#a6966a' as StreamTabId;
    const failingExecution = 'f6966f' as ExecutionId;
    const sweptExecution = 'a6966a' as ExecutionId;
    const seed = new StreamSnapshotStore();
    await seed.load([failingStream, sweptStream]);
    snapshotFacts(seed).setRunConfig(
      failingStream,
      toolUseConfig('search', 'deepseekproT'),
      failingExecution,
    );
    snapshotFacts(seed).setRunConfig(
      sweptStream,
      toolUseConfig('search', 'deepseekproT'),
      sweptExecution,
    );
    await writeExecutionConfig(failingExecution);
    await writeExecutionConfig(sweptExecution);
    await seed.flush();

    const { backend } = await createPersistentRecordingBackend();
    const stores = executionDeleter(backend);
    const originalDeleteExecution = stores.deleteExecution.bind(stores);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const deleteExecutionSpy = vi
      .spyOn(stores, 'deleteExecution')
      .mockImplementation(async (executionId, options) => {
        if (executionId === failingExecution) {
          throw new Error('locked execution dir');
        }
        return originalDeleteExecution(executionId, options);
      });

    try {
      await expect(backend.state.load()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        'SessionStores',
        `Skipping orphaned execution cleanup for ${failingExecution}; startup will continue.`,
        { data: expect.any(Error) },
      );
      expect(await StorageFS.exists(streamDataDir(failingStream))).toBe(true);
      expect(await StorageFS.exists(`executions/${failingExecution}`)).toBe(
        true,
      );
      expect(await StorageFS.exists(streamDataDir(sweptStream))).toBe(false);
      expect(await StorageFS.exists(`executions/${sweptExecution}`)).toBe(
        false,
      );
    } finally {
      deleteExecutionSpy.mockRestore();
      warnSpy.mockRestore();
      await getExecutionStore(failingExecution).clear();
      await getExecutionStore(sweptExecution).clear();
      await backend.state.clearAll();
    }
  });

  it('retains sidecar state for a durably registered empty stream', async () => {
    const stream = 'tool@deepseek#empty01' as StreamTabId;
    const executionId = 'e6966e' as ExecutionId;
    const first = await createPersistentRecordingBackend();

    try {
      first.backend.state.streamLogs.ensureStream(stream);
      snapshotFacts(first.backend.state.snapshots).setRunConfig(
        stream,
        toolUseConfig('search', 'deepseekproT'),
        executionId,
      );
      await writeExecutionConfig(executionId);
      await first.backend.state.flush();
    } finally {
      // The second backend reopens the same durable store, so the first one
      // has to be released here rather than at shared teardown.
      first.backend.dispose();
      first.session.dispose();
    }

    const second = await createPersistentRecordingBackend();
    try {
      await second.session.waitUntilReady();
      await second.backend.state.load();

      expect(second.backend.state.streamLogs.has(stream)).toBe(true);
      expect(second.backend.state.snapshots.getExecutionId(stream)).toBe(
        executionId,
      );
      expect(await StorageFS.exists(streamDataDir(stream))).toBe(true);
      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
    } finally {
      await second.backend.state.clearAll();
    }
  });
});
