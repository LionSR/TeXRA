import { describe, expect, it, vi } from 'vitest';

import { finalizeRun, getExecutionStore } from '@agent/storage';
import { writeSessionDescription } from '@agent/storage/executionLifecycle';
import { readExecutionMeta } from '@agent/storage/executionMetaPersistence';
import { KVStore } from '@common/storage/KVStore';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { STREAM_DATA_KEYS, streamDataDir } from '@transcript/streamDataPaths';
import { StorageFS } from '@utils/files/storageFS';

describe('execution metadata updates', () => {
  setupPlatform({ workspacePath: '/workspace' });

  it('keeps every field when updates for one execution overlap', async () => {
    const id = 'bbb001' as ExecutionId;
    await getExecutionStore(id).writeMeta({
      timestamp: new Date(0).toISOString(),
    });

    // Both are read-modify-write cycles over the same metadata record; without
    // per-execution serialization the later write drops the earlier field.
    await Promise.all([
      writeSessionDescription(id, 'A described session'),
      finalizeRun({
        executionId: id,
        outcome: RUN_OUTCOME.COMPLETED,
        flowRecord: 'preserve',
      }),
    ]);

    const meta = await getExecutionStore(id).readMeta();
    expect(meta?.description).toBe('A described session');
    expect(meta?.outcome).toBe(RUN_OUTCOME.COMPLETED);
  });

  // The host-exit drain finalizes CANCELLED for whatever a session still owns,
  // and can reach the meta lock just after the run's own driver recorded a real
  // outcome. Serialization alone would let it overwrite that; the backstop must
  // yield to the driver instead.
  it('keeps a driver-written outcome when a backstop finalizer follows it', async () => {
    const id = 'bbb002' as ExecutionId;
    await getExecutionStore(id).writeMeta({
      timestamp: new Date(0).toISOString(),
    });

    await finalizeRun({
      executionId: id,
      outcome: RUN_OUTCOME.COMPLETED,
      flowRecord: 'preserve',
    });
    await finalizeRun({
      executionId: id,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: 'preserve',
      keepExistingOutcome: true,
    });

    expect((await getExecutionStore(id).readMeta())?.outcome).toBe(
      RUN_OUTCOME.COMPLETED,
    );
  });

  it('preserves a stream ID persisted before a stale updater acquires its lease', async () => {
    const id = 'bbb005' as ExecutionId;
    const legacy = 'legacy-stream' as StreamTabId;
    const modern = 'modern-stream' as StreamTabId;
    const timestamp = new Date(0).toISOString();
    const store = getExecutionStore(id);
    await store.writeMeta({ timestamp });
    await new KVStore(streamDataDir(legacy)).write(STREAM_DATA_KEYS.META, {
      executionId: id,
    });
    const started = createDeferred();
    const release = createDeferred();
    const originalReadDir = StorageFS.readDir.bind(StorageFS);
    let blocked = false;
    const readDir = vi
      .spyOn(StorageFS, 'readDir')
      .mockImplementation(async (path) => {
        if (!blocked && path.includes(id)) {
          blocked = true;
          started.resolve();
          await release.promise;
        }
        return originalReadDir(path);
      });

    try {
      const staleUpdate = readExecutionMeta(id);
      await started.promise;
      // Model a second process that won its lease and persisted while this
      // updater was still outside its own lease-protected transaction.
      await new KVStore(resolveRunStoragePath(id)).write('meta', {
        timestamp,
        streamId: modern,
      });
      release.resolve();

      await expect(staleUpdate).resolves.toMatchObject({ streamId: modern });
      expect((await store.readMeta())?.streamId).toBe(modern);
    } finally {
      release.resolve();
      readDir.mockRestore();
    }
  });

  it('updates and finalizes core metadata despite malformed workflow observability', async () => {
    const id = 'bbb003' as ExecutionId;
    const store = getExecutionStore(id);
    await store.write('meta', {
      timestamp: new Date(0).toISOString(),
      identity: { kind: 'process', tool: 'bash' },
      description: 'Original description',
      workflow: { lifecycle: 'active' },
    });

    await writeSessionDescription(id, 'Updated description');
    await expect(
      finalizeRun({
        executionId: id,
        outcome: RUN_OUTCOME.COMPLETED,
        flowRecord: 'preserve',
      }),
    ).resolves.toMatchObject({ ok: true });

    const meta = await store.readMeta();
    expect(meta).toMatchObject({
      identity: { kind: 'process', tool: 'bash' },
      description: 'Updated description',
      outcome: RUN_OUTCOME.COMPLETED,
    });
    expect(meta?.workflow).toBeUndefined();
  });

  it('resolves to a failed result instead of rejecting when the terminal write fails', async () => {
    const id = 'bbb004' as ExecutionId;
    const store = getExecutionStore(id);
    await store.writeMeta({
      timestamp: new Date(0).toISOString(),
    });

    // Catchless callers rely on finalizeRun never rejecting: every store
    // failure must surface as an ok: false result (#10614). CANCELLED +
    // 'preserve' skips the fail-closed flow-record delete, isolating the
    // terminal-write arm.
    const writeError = new Error('terminal write rejected');
    const writeSpy = vi
      .spyOn(store, 'writeMeta')
      .mockRejectedValueOnce(writeError);
    try {
      await expect(
        finalizeRun({
          executionId: id,
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: 'preserve',
        }),
      ).resolves.toEqual({
        ok: false,
        error: writeError,
        outcomePersisted: false,
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('accepts a later update after one fails on absent metadata', async () => {
    const id = 'bbb002' as ExecutionId;
    // Nothing to read-modify-write yet: this update fails inside the lock and
    // must release it, or every later update for the execution would hang.
    const failing = writeSessionDescription(id, 'dropped');
    await getExecutionStore(id).writeMeta({
      timestamp: new Date(0).toISOString(),
    });
    await failing;

    await writeSessionDescription(id, 'Written after the failure');

    expect((await getExecutionStore(id).readMeta())?.description).toBe(
      'Written after the failure',
    );
  });
});
