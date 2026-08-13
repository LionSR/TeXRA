// Node imports
import * as path from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import type { StreamTabId } from '@shared/schemas';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  StagedDeletionCoordinator,
  type StagedDeletionHost,
} from '@transcript/StagedDeletionCoordinator';
import {
  stagedStreamDataDir,
  streamDataDir,
} from '@transcript/streamDataPaths';
import { StorageFS } from '@utils/files/storageFS';

/**
 * The staged-deletion state machine seen through its port alone — the contract
 * `StreamSnapshotStore` relies on and the disk transitions it can't observe
 * from the store's own public surface. Store-level behavior (buffered sidecar
 * round-trips, reconcile outcomes, flush recovery) stays covered end-to-end in
 * StreamSnapshotStore.vitest.ts; these cases pin the port itself.
 */

const tempDirs: string[] = [];
const STREAM = 'polish@gpt#abc123def' as StreamTabId;
const PLAN_KEY = 'workPlan';

interface FakeHost {
  host: StagedDeletionHost;
  /** Port calls in order, so crash-safety ordering is assertable. */
  calls: string[];
  /** Values that actually reached the store's durable write path. */
  persisted: Array<{ key: string; value: unknown; liveDirExisted: boolean }>;
  /** Simulates an unavailable sidecar write (disk full, permission denied). */
  control: { failWrites: boolean };
}

function createFakeHost(): FakeHost {
  const calls: string[] = [];
  const persisted: FakeHost['persisted'] = [];
  const control = { failWrites: false };
  const host: StagedDeletionHost = {
    queueWrite: async (stream, key, value) => {
      calls.push('queueWrite');
      if (control.failWrites) throw new Error('write unavailable');
      // Replay must land after the live namespace is restored, never while
      // the stream's directory is still parked in the deletion namespace.
      persisted.push({
        key,
        value,
        liveDirExisted: await StorageFS.exists(streamDataDir(stream)),
      });
    },
    cancelPendingWrites: () => {
      calls.push('cancelPendingWrites');
      return [];
    },
    bumpStreamVersion: () => {
      calls.push('bumpStreamVersion');
    },
    seedChain: () => undefined,
    invalidateKvHandles: () => {
      calls.push('invalidateKvHandles');
    },
    evict: () => {
      calls.push('evict');
    },
  };
  return { host, calls, persisted, control };
}

function setupCoordinator(): Omit<FakeHost, 'host'> & {
  coordinator: StagedDeletionCoordinator;
} {
  const { host, calls, persisted, control } = createFakeHost();
  return {
    coordinator: new StagedDeletionCoordinator(host),
    calls,
    persisted,
    control,
  };
}

/** A stream whose live sidecar directory already holds a persisted plan. */
async function writeLivePlan(value: unknown = { todos: [] }): Promise<void> {
  const dir = streamDataDir(STREAM);
  await StorageFS.ensureDir(dir);
  await StorageFS.write(
    path.join(dir, `${PLAN_KEY}.json`),
    JSON.stringify(value),
  );
}

describe('StagedDeletionCoordinator', () => {
  setupPlatform(() =>
    createTempDirPlatform('texra-staged-deletion-', tempDirs),
  );

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('cancels and invalidates queued writes before the staging rename', async () => {
    const { calls, coordinator } = setupCoordinator();
    await writeLivePlan();

    await coordinator.stage(STREAM);

    // Both must happen before the rename: a write queued against the
    // pre-staging directory would otherwise recreate it behind the move.
    expect(calls).toStrictEqual(['cancelPendingWrites', 'bumpStreamVersion']);
    expect(await StorageFS.exists(streamDataDir(STREAM))).toBe(false);
    expect(await StorageFS.exists(stagedStreamDataDir(STREAM))).toBe(true);
  });

  it('drops the in-memory record and the staged copy only on commit', async () => {
    const { calls, coordinator } = setupCoordinator();
    await writeLivePlan();

    const deletion = await coordinator.stage(STREAM);
    expect(calls).not.toContain('evict');

    await deletion.commit();

    expect(calls).toContain('evict');
    expect(await StorageFS.exists(stagedStreamDataDir(STREAM))).toBe(false);
    expect(await StorageFS.exists(streamDataDir(STREAM))).toBe(false);
  });

  it('buffers writes while staged and replays them after rollback restores the live namespace', async () => {
    const { coordinator, persisted } = setupCoordinator();
    await writeLivePlan();
    const deletion = await coordinator.stage(STREAM);

    expect(
      coordinator.bufferWrite(STREAM, PLAN_KEY, { todos: ['later'] }),
    ).toBe(true);
    expect(persisted).toStrictEqual([]);

    await deletion.rollback();

    expect(persisted).toStrictEqual([
      { key: PLAN_KEY, value: { todos: ['later'] }, liveDirExisted: true },
    ]);
    // Ownership is released once the buffer drains, so later writes go
    // straight back to the store's ordinary path.
    expect(coordinator.bufferWrite(STREAM, PLAN_KEY, {})).toBe(false);
  });

  it('discards buffered writes when the deletion commits', async () => {
    const { coordinator, persisted } = setupCoordinator();
    await writeLivePlan();
    const deletion = await coordinator.stage(STREAM);

    coordinator.bufferWrite(STREAM, PLAN_KEY, { todos: ['discarded'] });
    await deletion.commit();

    expect(persisted).toStrictEqual([]);
  });

  it('leaves a write unbuffered when no deletion owns the stream', () => {
    const { coordinator, persisted } = setupCoordinator();

    expect(coordinator.bufferWrite(STREAM, PLAN_KEY, { todos: [] })).toBe(
      false,
    );
    expect(persisted).toStrictEqual([]);
  });

  it('keeps a buffered value over a cancelled dirty write for the same sidecar', async () => {
    const { coordinator, persisted } = setupCoordinator();
    await writeLivePlan();
    const deletion = await coordinator.stage(STREAM);

    coordinator.bufferWrite(STREAM, PLAN_KEY, { todos: ['newer'] });
    // A dirty write sampled by the cancelling sweep is older than anything
    // buffered after staging began, so it must not win.
    coordinator.captureDirtyWrite(STREAM, PLAN_KEY, { todos: ['older'] });
    coordinator.captureDirtyWrite(STREAM, 'meta', { schemaVersion: 1 });

    await deletion.rollback();

    expect(persisted).toContainEqual({
      key: PLAN_KEY,
      value: { todos: ['newer'] },
      liveDirExisted: true,
    });
    expect(persisted).toContainEqual({
      key: 'meta',
      value: { schemaVersion: 1 },
      liveDirExisted: true,
    });
  });

  it('reset drops in-memory ownership while on-disk staging residue still blocks a new deletion', async () => {
    const { coordinator } = setupCoordinator();
    await writeLivePlan();
    await coordinator.stage(STREAM);

    coordinator.reset();

    expect(coordinator.bufferWrite(STREAM, PLAN_KEY, {})).toBe(false);
    // Disk, not memory, is authoritative for an unreconciled deletion.
    await expect(coordinator.stage(STREAM)).rejects.toThrow(
      /unreconciled snapshot deletion/,
    );
  });

  it('reconcile restores a crash-left staged directory and invalidates cached KV handles', async () => {
    const { calls, coordinator } = setupCoordinator();
    const stagedDir = stagedStreamDataDir(STREAM);
    await StorageFS.ensureDir(stagedDir);
    await StorageFS.write(
      path.join(stagedDir, `${PLAN_KEY}.json`),
      JSON.stringify({ todos: ['survived'] }),
    );

    const outcome = await coordinator.reconcile(new Set([STREAM]));

    expect(outcome).toStrictEqual({
      restored: [STREAM],
      pendingCleanup: [],
      discarded: [],
    });
    // The store cached a KV handle for the directory that just moved.
    expect(calls).toContain('invalidateKvHandles');
    expect(
      await StorageFS.readJson(
        path.join(streamDataDir(STREAM), `${PLAN_KEY}.json`),
      ),
    ).toStrictEqual({ todos: ['survived'] });
  });

  it('recoverPendingRollbacks replays writes stranded by a failed rollback', async () => {
    const { coordinator, persisted, control } = setupCoordinator();
    await writeLivePlan();
    const deletion = await coordinator.stage(STREAM);
    coordinator.bufferWrite(STREAM, PLAN_KEY, { todos: ['stranded'] });

    control.failWrites = true;
    await expect(deletion.rollback()).rejects.toThrow('write unavailable');
    expect(persisted).toStrictEqual([]);

    // The buffer survives the failure, so the store's `flush()` recovery pass
    // can make it durable instead of the value being lost with the rollback.
    control.failWrites = false;
    expect(await coordinator.recoverPendingRollbacks()).toStrictEqual([]);
    expect(persisted).toStrictEqual([
      { key: PLAN_KEY, value: { todos: ['stranded'] }, liveDirExisted: true },
    ]);
  });
});
