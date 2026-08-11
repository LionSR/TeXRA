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
import { StorageFS } from '@utils/files/storageFS';

import {
  createIsolatedRecordingBackend,
  createPersistentRecordingBackend,
  executionDeleter,
  toolUseConfig,
  writeExecutionConfig,
} from './progressBackendHarness';

type IsolatedBackend = ReturnType<
  typeof createIsolatedRecordingBackend
>['backend'];

interface StreamExecution {
  stream: StreamTabId;
  executionId: ExecutionId;
}

function toolStreamAndExecution(id: string): StreamExecution {
  return {
    stream: `tool@deepseek#${id}` as StreamTabId,
    executionId: id as ExecutionId,
  };
}

/** Registers a stream with the run config the execution store also records. */
function registerStream(
  backend: IsolatedBackend,
  { stream, executionId }: StreamExecution,
): void {
  backend.state.streamLogs.ensureStream(stream);
  snapshotFacts(backend.state.snapshots).setRunConfig(
    stream,
    toolUseConfig('search', 'deepseekproT'),
    executionId,
  );
}

/** Registers a stream and persists its sidecar and execution config. */
async function seedOwnedStream(
  backend: IsolatedBackend,
  ids: StreamExecution,
  options: { load?: boolean } = {},
): Promise<void> {
  if (options.load) {
    await backend.state.snapshots.load([ids.stream]);
  }
  registerStream(backend, ids);
  await writeExecutionConfig(ids.executionId);
  await backend.state.flush();
}

/** Persists sidecars and execution configs for orphaned streams on disk. */
async function seedOrphanedSnapshots(
  orphans: StreamExecution[],
  options: { load?: StreamTabId[] } = {},
): Promise<StreamSnapshotStore> {
  const seed = new StreamSnapshotStore();
  await seed.load(options.load ?? orphans.map((orphan) => orphan.stream));
  for (const { stream, executionId } of orphans) {
    snapshotFacts(seed).setRunConfig(
      stream,
      toolUseConfig('search', 'deepseekproT'),
      executionId,
    );
    await writeExecutionConfig(executionId);
  }
  await seed.flush();
  return seed;
}

async function expectStored(path: string, expected: boolean): Promise<void> {
  expect(await StorageFS.exists(path)).toBe(expected);
}

describe('ProgressBackend cleanup', () => {
  it('deletes the execution directory named by stream metadata when a stream is cleared', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const { stream, executionId } = toolStreamAndExecution('a6966a');

    try {
      await seedOwnedStream(backend, { stream, executionId }, { load: true });
      await GoalStore.start(stream, 'finish the cleanup');

      await expectStored(`executions/${executionId}`, true);
      await expectStored(streamDataDir(stream), true);

      await backend.state.clearStream(stream);

      await expectStored(`executions/${executionId}`, false);
      await expectStored(streamDataDir(stream), false);
      expect(GoalStore.getForStream(stream)).toBeNull();
    } finally {
      await GoalStore.forget(stream);
      await backend.state.clearAll();
    }
  });

  it('retains stream state and execution config when adjacent cleanup fails', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const { stream, executionId } = toolStreamAndExecution('a6966f');
    const snapshotDeleteSpy = vi
      .spyOn(backend.state.snapshots, 'stageDeleteStream')
      .mockRejectedValueOnce(new Error('snapshot directory is locked'));

    try {
      await seedOwnedStream(backend, { stream, executionId });

      await expect(backend.state.clearStream(stream)).resolves.toBe('failed');

      expect(backend.state.streamLogs.has(stream)).toBe(true);
      expect(backend.state.snapshots.getRunMetadata(stream)).toMatchObject({
        config: toolUseConfig('search', 'deepseekproT'),
        executionId,
      });
      await expectStored(`executions/${executionId}`, true);
    } finally {
      snapshotDeleteSpy.mockRestore();
      await backend.state.clearAll();
    }
  });

  it('commits stream deletion when only final execution cleanup fails', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const { stream, executionId } = toolStreamAndExecution('a6966e');
    const deleteExecutionSpy = vi
      .spyOn(executionDeleter(backend), 'deleteExecution')
      .mockImplementation(async (_id, options) => {
        await options?.beforeDelete?.();
        throw new Error('execution directory is locked');
      });

    try {
      await seedOwnedStream(backend, { stream, executionId });

      await expect(backend.state.clearStream(stream)).resolves.toBe('deleted');

      expect(backend.state.streamLogs.has(stream)).toBe(false);
      expect(
        backend.state.snapshots.getRunMetadata(stream).config,
      ).toBeUndefined();
      await expectStored(`executions/${executionId}`, true);
    } finally {
      deleteExecutionSpy.mockRestore();
      await getExecutionStore(executionId).clear();
      await backend.state.clearAll();
    }
  });

  it('does not retain a stream after the transcript commit point', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const { stream, executionId } = toolStreamAndExecution('a69660');
    const forgetSpy = vi
      .spyOn(GoalStore, 'forget')
      .mockRejectedValueOnce(new Error('goal state is locked'));

    try {
      await seedOwnedStream(backend, { stream, executionId });

      await expect(backend.state.clearStream(stream)).resolves.toBe('deleted');

      expect(backend.state.streamLogs.has(stream)).toBe(false);
      await expectStored(streamDataDir(stream), false);
      await expectStored(`executions/${executionId}`, false);
    } finally {
      forgetSpy.mockRestore();
      await backend.state.clearAll();
    }
  });

  it('retains execution sidecars and goals for an externally active run', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const { stream, executionId } = toolStreamAndExecution('a6966b');

    try {
      await seedOwnedStream(backend, { stream, executionId }, { load: true });
      await GoalStore.start(stream, 'preserve the active execution');
      await writeForeignLease(executionId);

      await backend.state.clearStream(stream);

      await expectStored(`executions/${executionId}`, true);
      await expectStored(streamDataDir(stream), true);
      expect(GoalStore.getForStream(stream)).not.toBeNull();
    } finally {
      await StorageFS.delete(executionLeasePath(executionId)).catch(() => {});
      await GoalStore.forget(stream);
      await getExecutionStore(executionId).clear();
      await backend.state.clearAll();
    }
  });

  it('never derives execution ownership from the stream id: stream state clears, execution survives', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const { stream, executionId } = toolStreamAndExecution('a6966c');

    try {
      await backend.state.snapshots.load([stream]);
      backend.state.streamLogs.ensureStream(stream);
      await writeExecutionConfig(executionId);
      await backend.state.flush();
      await StorageFS.ensureDir(streamDataDir(stream));
      await GoalStore.start(stream, 'goal on an unowned stream');
      await writeForeignLease(executionId);

      await backend.state.clearStream(stream);

      // Name resemblance is not ownership: the stream's own state goes, the
      // execution directory it merely resembles is untouched.
      await expectStored(`executions/${executionId}`, true);
      await expectStored(streamDataDir(stream), false);
      expect(GoalStore.getForStream(stream)).toBeNull();
    } finally {
      await StorageFS.delete(executionLeasePath(executionId)).catch(() => {});
      await GoalStore.forget(stream);
      await getExecutionStore(executionId).clear();
      await backend.state.clearAll();
    }
  });

  it('clears a log-only stream during bulk cleanup without touching its unowned execution', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const { stream, executionId } = toolStreamAndExecution('a6966d');

    try {
      backend.state.streamLogs.ensureStream(stream);
      await writeExecutionConfig(executionId);
      await GoalStore.start(stream, 'goal on a log-only stream');
      await writeForeignLease(executionId);

      const retained = await backend.state.clearAll();

      // A log-only stream carries no sidecar FK, so it owns no execution:
      // its stream state clears and the leased execution stays untouched.
      expect(retained).toEqual({ active: new Set(), failed: new Set() });
      expect(backend.state.streamLogs.has(stream)).toBe(false);
      await expectStored(`executions/${executionId}`, true);
    } finally {
      await StorageFS.delete(executionLeasePath(executionId)).catch(() => {});
      await GoalStore.forget(stream);
      await getExecutionStore(executionId).clear();
      await backend.state.clearAll();
    }
  });

  it('serializes bulk cleanup behind an existing staged deletion', async () => {
    const { backend } = createIsolatedRecordingBackend();
    const { stream, executionId } = toolStreamAndExecution('a6966e');
    let stagedDeletion:
      | Awaited<ReturnType<typeof backend.state.snapshots.stageDeleteStream>>
      | undefined;

    try {
      await seedOwnedStream(backend, { stream, executionId }, { load: true });
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
      await expectStored(`executions/${executionId}`, false);
    } finally {
      await stagedDeletion?.rollback();
      await getExecutionStore(executionId).clear();
      await backend.state.clearAll();
    }
  });

  it('reconciles required cleanup and final execution cleanup independently', async () => {
    const failed = toolStreamAndExecution('fa11ed6966');
    const incomplete = toolStreamAndExecution('faded6966');
    const deleted = toolStreamAndExecution('de1e7ed6966');
    const { backend } = createIsolatedRecordingBackend();
    for (const ids of [failed, incomplete, deleted]) {
      registerStream(backend, ids);
    }
    const deleteExecutionSpy = vi
      .spyOn(executionDeleter(backend), 'deleteExecution')
      .mockImplementation(async (executionId, options) => {
        if (executionId === failed.executionId) {
          throw new Error('execution directory is locked');
        }
        await options?.beforeDelete?.();
        if (executionId === incomplete.executionId) {
          throw new Error('execution directory is locked');
        }
        return { status: 'deleted', executionId };
      });

    try {
      const result = await backend.state.clearAll();

      expect(result).toEqual({
        active: new Set(),
        failed: new Set([failed.stream]),
      });
      expect(backend.state.streamLogs.has(failed.stream)).toBe(true);
      expect(backend.state.streamLogs.has(incomplete.stream)).toBe(false);
      expect(backend.state.streamLogs.has(deleted.stream)).toBe(false);
    } finally {
      deleteExecutionSpy.mockRestore();
      await backend.state.clearAll();
    }
  });

  it('does not retain bulk-deleted streams after the transcript commit point', async () => {
    const { stream, executionId } = toolStreamAndExecution('b69660');
    const { backend } = createIsolatedRecordingBackend();
    registerStream(backend, { stream, executionId });
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
      await expectStored(streamDataDir(stream), false);
      await expectStored(`executions/${executionId}`, false);
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
    registerStream(backend, { stream: failedStream, executionId });
    registerStream(backend, { stream: deletedStream, executionId });
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
      expect(
        backend.state.snapshots.getRunMetadata(failedStream).executionId,
      ).toBe(executionId);
      await expectStored(streamDataDir(failedStream), true);
      await expectStored(`executions/${executionId}`, true);

      deleteTranscriptSpy.mockRestore();
      await expect(backend.state.clearStream(failedStream)).resolves.toBe(
        'deleted',
      );
      await expectStored(`executions/${executionId}`, false);
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

      await expectStored(sentinel, true);
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
    const orphan = toolStreamAndExecution('b6966b');
    const historyExecution = 'c6966c' as ExecutionId;

    const { backend } = await createPersistentRecordingBackend();
    try {
      await seedOrphanedSnapshots([orphan]);
      await writeExecutionConfig(historyExecution);
      await GoalStore.start(orphan.stream, 'sweep this orphan');

      await expectStored(streamDataDir(orphan.stream), true);
      await expectStored(`executions/${orphan.executionId}`, true);
      await expectStored(`executions/${historyExecution}`, true);

      await backend.state.load();

      await expectStored(streamDataDir(orphan.stream), false);
      await expectStored(`executions/${orphan.executionId}`, false);
      await expectStored(`executions/${historyExecution}`, true);
      expect(GoalStore.getForStream(orphan.stream)).toBeNull();
    } finally {
      await GoalStore.forget(orphan.stream);
      await getExecutionStore(historyExecution).clear();
      await backend.state.clearAll();
    }
  });

  it('finishes a staged deletion whose transcript committed before a crash', async () => {
    const { stream, executionId } = toolStreamAndExecution('c69660');
    const seed = await seedOrphanedSnapshots([{ stream, executionId }], {
      load: [],
    });
    await GoalStore.start(stream, 'finish this interrupted deletion');
    await seed.stageDeleteStream(stream);

    const { backend } = await createPersistentRecordingBackend();
    try {
      await expectStored(streamDataDir(stream), false);
      expect(await seed.listStagedDeletions()).toContain(stream);

      await backend.state.load();

      expect(await backend.state.snapshots.listStagedDeletions()).not.toContain(
        stream,
      );
      await expectStored(`executions/${executionId}`, false);
      expect(GoalStore.getForStream(stream)).toBeNull();
    } finally {
      await GoalStore.forget(stream);
      await backend.state.clearAll();
    }
  });

  it('finishes committed staged residue without requiring a reload', async () => {
    const { stream, executionId } = toolStreamAndExecution('c69661');
    const { backend } = createIsolatedRecordingBackend();
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
      await expectStored(`executions/${executionId}`, false);
      expect(GoalStore.getForStream(stream)).toBeNull();
    } finally {
      deleteSpy.mockRestore();
      await GoalStore.forget(stream);
      await backend.state.clearAll();
    }
  });

  const orphanSweepFailures: Array<{
    case: string;
    install: (
      backend: IsolatedBackend,
      failing: StreamExecution,
    ) => { mockRestore(): void };
  }> = [
    {
      case: 'one orphan cleanup fails',
      install: (backend, failing) => {
        const stageDeleteStream =
          backend.state.snapshots.stageDeleteStream.bind(
            backend.state.snapshots,
          );
        return vi
          .spyOn(backend.state.snapshots, 'stageDeleteStream')
          .mockImplementation(async (stream) => {
            if (stream === failing.stream) {
              throw new Error('locked stream sidecar');
            }
            return stageDeleteStream(stream);
          });
      },
    },
    {
      case: 'one execution cleanup fails',
      install: (backend, failing) => {
        const stores = executionDeleter(backend);
        const deleteExecution = stores.deleteExecution.bind(stores);
        return vi
          .spyOn(stores, 'deleteExecution')
          .mockImplementation(async (executionId, options) => {
            if (executionId === failing.executionId) {
              throw new Error('locked execution dir');
            }
            return deleteExecution(executionId, options);
          });
      },
    },
  ];

  it.each(orphanSweepFailures)(
    'continues sweeping streamData orphans when $case',
    async ({ install }) => {
      const failing = toolStreamAndExecution('d6966d');
      const swept = toolStreamAndExecution('e6966e');
      await seedOrphanedSnapshots([failing, swept]);

      const { backend } = await createPersistentRecordingBackend();
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const failureSpy = install(backend, failing);

      try {
        await expect(backend.state.load()).resolves.toBeUndefined();

        expect(warnSpy).toHaveBeenCalledWith(
          'SessionStores',
          `Skipping orphaned execution cleanup for ${failing.executionId}; startup will continue.`,
          { data: expect.any(Error) },
        );
        await expectStored(streamDataDir(failing.stream), true);
        await expectStored(`executions/${failing.executionId}`, true);
        await expectStored(streamDataDir(swept.stream), false);
        await expectStored(`executions/${swept.executionId}`, false);
      } finally {
        failureSpy.mockRestore();
        warnSpy.mockRestore();
        await getExecutionStore(failing.executionId).clear();
        await getExecutionStore(swept.executionId).clear();
        await backend.state.clearAll();
      }
    },
  );

  it('retains sidecar state for a durably registered empty stream', async () => {
    const stream = 'tool@deepseek#empty01' as StreamTabId;
    const executionId = 'e6966e' as ExecutionId;
    const first = await createPersistentRecordingBackend();

    try {
      registerStream(first.backend, { stream, executionId });
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
      expect(
        second.backend.state.snapshots.getRunMetadata(stream).executionId,
      ).toBe(executionId);
      await expectStored(streamDataDir(stream), true);
      await expectStored(`executions/${executionId}`, true);
    } finally {
      await second.backend.state.clearAll();
    }
  });

  it('sweeps leftover background shells at load, keeping real sessions', async () => {
    // No identity on its execution row: every stream a workspace wrote before
    // identity stamping (#9705) hydrates this way, so the sweep has only the
    // minted prefix to read.
    const shell = {
      stream: 'bash@tool#a6961a' as StreamTabId,
      executionId: 'a6961a' as ExecutionId,
    };
    const session = toolStreamAndExecution('b6961b');
    const first = await createPersistentRecordingBackend();

    try {
      for (const ids of [shell, session]) {
        registerStream(first.backend, ids);
        await writeExecutionConfig(ids.executionId);
      }
      await first.backend.state.flush();
    } finally {
      first.backend.dispose();
      first.session.dispose();
    }

    const second = await createPersistentRecordingBackend();
    try {
      await second.session.waitUntilReady();
      await second.backend.state.load();

      expect(second.backend.state.streamLogs.has(shell.stream)).toBe(false);
      await expectStored(streamDataDir(shell.stream), false);
      await expectStored(`executions/${shell.executionId}`, false);

      // A real session is untouched, whatever its age.
      expect(second.backend.state.streamLogs.has(session.stream)).toBe(true);
      await expectStored(`executions/${session.executionId}`, true);
    } finally {
      await second.backend.state.clearAll();
    }
  });
});
