import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearStoreCache,
  finalizeExecution,
  getExecutionStore,
} from '@agent/storage';
import {
  deleteAllExecutions,
  deleteExecution,
} from '@agent/storage/executionListing';
import {
  ExecutionLeaseActiveError,
  ExecutionLeaseLostError,
  abandonOwnedExecutionLease,
  acquireFreshExecutionLease,
  acquireResumedExecutionLease,
  captureOwnedExecutionLease,
  completeOwnedExecutionLease,
  inspectExecutionLease,
  isOwnedExecutionLeaseDurable,
  markOwnedExecutionLeaseUndurable,
  onOwnedExecutionLeaseLost,
  ownsExecutionLease,
  reclaimExecutionLease,
  releaseOwnedExecutionLease,
  resetExecutionLeaseCoordinationForTests,
  runWithInactiveExecutionLease,
  captureOwnedExecutionLeaseIfPresent,
  validateOwnedExecutionLease,
  waitForOwnedExecutionLeaseRelease,
} from '@agent/storage/executionLease';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { platform } from '@platform/platform';
import { RUN_OUTCOME, type ExecutionId } from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import {
  deadOwner,
  executionLeasePath,
  startForeignInstance,
  writeForeignLease,
  writeOrphanedLease,
} from '@test/support/executionLeaseFixtures';
import type { FakeProcesses } from '@test/support/FakePlatform';
import { StorageFS } from '@utils/files/storageFS';

const ownedExecutionIds = new Set<ExecutionId>();

async function writeExecution(executionId: ExecutionId): Promise<void> {
  await getExecutionStore(executionId).writeMeta({
    timestamp: '2026-07-16T12:00:00.000Z',
  });
}

async function acquire(executionId: ExecutionId): Promise<void> {
  ownedExecutionIds.add(executionId);
  await acquireResumedExecutionLease(executionId);
}

function fakeProcesses(): FakeProcesses {
  return platform().processes as FakeProcesses;
}

/** Gate one read of the lease record so a concurrent step can interleave. */
function gateNextLeaseRead(): {
  started: Promise<void>;
  release: () => void;
} {
  const fs = platform().fs;
  const originalReadFile = fs.readFile.bind(fs);
  const started = createDeferred();
  const gate = createDeferred();
  vi.spyOn(fs, 'readFile').mockImplementationOnce(async (target) => {
    started.resolve();
    await gate.promise;
    return originalReadFile(target);
  });
  return { started: started.promise, release: () => gate.resolve() };
}

afterEach(async () => {
  vi.restoreAllMocks();
  fakeProcesses().reset();
  await Promise.all([...ownedExecutionIds].map(releaseOwnedExecutionLease));
  ownedExecutionIds.clear();
  await StorageFS.delete(WORKSPACE_STORAGE_LAYOUT.executionLeases, {
    recursive: true,
  }).catch(() => {});
  await StorageFS.delete('executions', { recursive: true }).catch(() => {});
  clearStoreCache();
  resetExecutionLeaseCoordinationForTests();
});

beforeEach(() => {
  clearStoreCache();
});

describe('cross-process execution leases', () => {
  it('protects a freshly leased execution from single deletion', async () => {
    const executionId = 'a8644a' as ExecutionId;
    await writeExecution(executionId);
    await writeForeignLease(executionId);

    await expect(deleteExecution(executionId)).resolves.toMatchObject({
      status: 'active',
      executionId,
    });
    expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
  });

  it('takes over an orphaned lease whose owner is provably dead', async () => {
    const executionId = 'b8644b' as ExecutionId;
    await writeOrphanedLease(executionId);

    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'orphaned',
    });
    await acquire(executionId);

    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'owned',
    });
  });

  it('fails closed when present lease state is malformed', async () => {
    const executionId = 'c8644c' as ExecutionId;
    await writeExecution(executionId);
    await StorageFS.ensureDir(WORKSPACE_STORAGE_LAYOUT.executionLeases);
    await StorageFS.writeAtomic(
      executionLeasePath(executionId),
      '{"version":3}',
    );

    await expect(deleteExecution(executionId)).rejects.toThrow(
      'Failed to parse JSON',
    );
    expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
  });

  it.each([
    {
      era: 'heartbeat (v1)',
      record:
        '{"version":1,"executionId":"c8644d","ownerToken":"00000000-0000-4000-8000-000000000009","acquiredAt":1,"heartbeatAt":1}',
    },
    {
      era: 'presence socket (v2)',
      record:
        '{"version":2,"executionId":"c8644d","ownerToken":"00000000-0000-4000-8000-000000000009","acquiredAt":1,"owner":{"instanceId":"x","socketPath":"/tmp/x.sock","pid":1,"hostname":"h"}}',
    },
  ])('retires a $era lease record on contact', async ({ record }) => {
    const executionId = 'c8644d' as ExecutionId;
    await writeExecution(executionId);
    await StorageFS.ensureDir(WORKSPACE_STORAGE_LAYOUT.executionLeases);
    await StorageFS.writeAtomic(executionLeasePath(executionId), record);

    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'orphaned',
    });
    await expect(deleteExecution(executionId)).resolves.toMatchObject({
      status: 'deleted',
    });
    expect(await StorageFS.exists(executionLeasePath(executionId))).toBe(false);
    expect(
      await StorageFS.readDir(WORKSPACE_STORAGE_LAYOUT.executionLeases),
    ).toEqual([]);
  });

  it('classifies a live pid whose start time differs from the record as orphaned', async () => {
    const executionId = 'b8644e' as ExecutionId;
    const foreign = await startForeignInstance();
    try {
      await writeForeignLease(executionId, undefined, {
        ...foreign.owner,
        processStartTime: foreign.owner.processStartTime! - 60_000,
      });

      await expect(inspectExecutionLease(executionId)).resolves.toEqual({
        status: 'orphaned',
      });
    } finally {
      await foreign.shutdown();
    }
  });

  it('classifies a killed owner as orphaned once its pid is gone', async () => {
    const executionId = 'b8644d' as ExecutionId;
    const foreign = await startForeignInstance();
    await writeForeignLease(executionId, undefined, foreign.owner);

    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'foreign',
      provable: true,
    });
    await foreign.shutdown();
    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'orphaned',
    });
  });

  it.each([
    {
      label: 'a cross-host owner',
      owner: async () => ({
        ...(await deadOwner()),
        hostname: 'texra-some-other-host',
      }),
    },
    {
      label: 'a live pid whose start time cannot be read',
      owner: async () => {
        fakeProcesses().setStartTime(process.pid, undefined);
        return {
          pid: process.pid,
          processStartTime: 1,
          hostname: os.hostname(),
        };
      },
    },
  ])('treats $label as unprovable and never reclaims it', async ({ owner }) => {
    const executionId = 'b8644f' as ExecutionId;
    await writeForeignLease(executionId, undefined, await owner());
    const operation = vi.fn(async () => 'removed');

    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'foreign',
      provable: false,
    });
    await expect(
      runWithInactiveExecutionLease(executionId, operation),
    ).resolves.toMatchObject({ status: 'active', provable: false });
    expect(operation).not.toHaveBeenCalled();
    await expect(
      acquireResumedExecutionLease(executionId),
    ).rejects.toMatchObject({
      name: 'ExecutionLeaseActiveError',
      provable: false,
    });
    expect(await StorageFS.exists(executionLeasePath(executionId))).toBe(true);
  });

  it('reclaims an unprovable owner only on explicit request, never a live one', async () => {
    const unprovableId = 'b86450' as ExecutionId;
    const liveId = 'b86451' as ExecutionId;
    await writeForeignLease(unprovableId, undefined, {
      ...(await deadOwner()),
      hostname: 'texra-some-other-host',
    });
    await writeForeignLease(liveId);

    await expect(reclaimExecutionLease(liveId)).resolves.toBe('alive');
    expect(await StorageFS.exists(executionLeasePath(liveId))).toBe(true);

    await expect(reclaimExecutionLease(unprovableId)).resolves.toBe(
      'reclaimed',
    );
    await expect(inspectExecutionLease(unprovableId)).resolves.toEqual({
      status: 'missing',
    });
    await expect(reclaimExecutionLease(unprovableId)).resolves.toBe('missing');
    await acquire(unprovableId);
  });

  it('lets exactly one of two concurrent fresh claims win, with no lock directory', async () => {
    const executionId = 'b86452' as ExecutionId;
    const outcomes = await Promise.allSettled([
      acquireFreshExecutionLease(executionId),
      acquireFreshExecutionLease(executionId),
    ]);
    ownedExecutionIds.add(executionId);

    const winners = outcomes.filter(
      (outcome) =>
        outcome.status === 'fulfilled' && outcome.value === 'acquired',
    );
    const losers = outcomes.filter(
      (outcome) =>
        outcome.status === 'rejected' &&
        outcome.reason instanceof ExecutionLeaseActiveError,
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(ownsExecutionLease(executionId)).toBe(true);
    expect(await StorageFS.readDir('.')).not.toContain('executionLocks');
    expect(
      (await StorageFS.readDir(WORKSPACE_STORAGE_LAYOUT.executionLeases)).map(
        ([name]) => name,
      ),
    ).toEqual([`${executionId}.json`]);
  });

  it('rejects resume while another live owner holds the lease', async () => {
    const executionId = 'd8644d' as ExecutionId;
    await writeForeignLease(executionId);

    await expect(
      acquireResumedExecutionLease(executionId),
    ).rejects.toBeInstanceOf(ExecutionLeaseActiveError);
  });

  it('does not create a resumed lease when canonical admission is withdrawn', async () => {
    const executionId = 'd8644e' as ExecutionId;

    await expect(
      acquireResumedExecutionLease(executionId, () => false),
    ).resolves.toBe('cancelled');
    expect(ownsExecutionLease(executionId)).toBe(false);
    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('claims nothing while canonical resume admission is pending', async () => {
    const executionId = 'd8644f' as ExecutionId;
    const admissionStarted = createDeferred();
    const admission = createDeferred<boolean>();
    const acquisition = acquireResumedExecutionLease(executionId, () => {
      admissionStarted.resolve();
      return admission.promise;
    });
    await admissionStarted.promise;

    // Nothing is claimed before admission, so maintenance proceeds and a
    // withdrawn admission leaves no record behind.
    await expect(
      runWithInactiveExecutionLease(executionId, async () => 'swept'),
    ).resolves.toEqual({ status: 'performed', value: 'swept' });

    admission.resolve(false);
    await expect(acquisition).resolves.toBe('cancelled');
    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('timestamps a resumed lease after asynchronous admission completes', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-25T12:00:00.000Z') });
    const admissionDelayMs = 90_000;
    const executionId = 'd86450' as ExecutionId;
    const expectedAcquiredAt = Date.now() + admissionDelayMs;

    try {
      await expect(
        acquireResumedExecutionLease(executionId, async () => {
          await vi.advanceTimersByTimeAsync(admissionDelayMs);
          return true;
        }),
      ).resolves.toBe('acquired');
      ownedExecutionIds.add(executionId);

      const persisted = JSON.parse(
        await StorageFS.read(executionLeasePath(executionId)),
      ) as { acquiredAt: number };
      expect(persisted).toMatchObject({ acquiredAt: expectedAcquiredAt });
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a transient resume validation failure without dropping ownership', async () => {
    const executionId = 'd86451' as ExecutionId;
    await acquire(executionId);
    vi.spyOn(platform().fs, 'readFile').mockRejectedValueOnce(
      new Error('temporary filesystem failure'),
    );

    await expect(
      acquireResumedExecutionLease(executionId, () => true),
    ).rejects.toThrow('temporary filesystem failure');
    expect(ownsExecutionLease(executionId)).toBe(true);
  });

  it('keeps resumed ownership live until terminal lifecycle release', async () => {
    const executionId = 'd86440' as ExecutionId;
    await writeExecution(executionId);
    await acquire(executionId);

    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'owned',
    });
    await finalizeExecution({
      executionId,
      outcome: RUN_OUTCOME.COMPLETED,
      flowRecord: 'preserve',
    });
    await releaseOwnedExecutionLease(executionId);
    ownedExecutionIds.delete(executionId);

    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('settles local release waiters when the matching owner releases', async () => {
    const executionId = 'd86441' as ExecutionId;
    await acquire(executionId);
    let settled = false;
    const waiting = waitForOwnedExecutionLeaseRelease(executionId).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    await releaseOwnedExecutionLease(executionId);
    ownedExecutionIds.delete(executionId);

    await waiting;
    expect(settled).toBe(true);
  });

  it('stops claiming but preserves the lease after durability failure', async () => {
    const executionId = 'd86442' as ExecutionId;
    await acquire(executionId);

    abandonOwnedExecutionLease(executionId);
    ownedExecutionIds.delete(executionId);

    expect(ownsExecutionLease(executionId)).toBe(false);
    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'foreign',
    });
  });

  it('abandons rather than releases an execution marked undurable', async () => {
    const executionId = 'd86443' as ExecutionId;
    await acquire(executionId);

    expect(isOwnedExecutionLeaseDurable(executionId)).toBe(true);
    markOwnedExecutionLeaseUndurable(executionId);
    expect(isOwnedExecutionLeaseDurable(executionId)).toBe(false);
    await expect(completeOwnedExecutionLease(executionId)).resolves.toEqual({
      status: 'retained',
      reason: 'undurable',
    });
    ownedExecutionIds.delete(executionId);

    expect(ownsExecutionLease(executionId)).toBe(false);
    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'foreign',
    });
  });

  it('reports lease deletion failure while retaining its persisted record', async () => {
    const executionId = 'd86444' as ExecutionId;
    const deletionError = new Error('lease deletion failed');
    await acquire(executionId);
    vi.spyOn(StorageFS, 'delete').mockRejectedValueOnce(deletionError);

    await expect(completeOwnedExecutionLease(executionId)).resolves.toEqual({
      status: 'retained',
      reason: 'release-failed',
      error: deletionError,
    });
    ownedExecutionIds.delete(executionId);

    expect(ownsExecutionLease(executionId)).toBe(false);
    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'foreign',
    });
  });

  it('releases only when the persisted owner still matches', async () => {
    const executionId = 'e8644e' as ExecutionId;
    await acquire(executionId);
    await writeForeignLease(
      executionId,
      '00000000-0000-4000-8000-000000000002',
    );

    await releaseOwnedExecutionLease(executionId);
    ownedExecutionIds.delete(executionId);

    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'foreign',
    });
  });

  it('fences an execution-store write immediately after takeover', async () => {
    const executionId = 'e86440' as ExecutionId;
    await acquire(executionId);
    const onLeaseLost = vi.fn();
    onOwnedExecutionLeaseLost(executionId, onLeaseLost);
    await captureOwnedExecutionLease(executionId)(async () => {
      await writeForeignLease(
        executionId,
        '00000000-0000-4000-8000-000000000004',
      );

      await expect(writeExecution(executionId)).rejects.toBeInstanceOf(
        ExecutionLeaseLostError,
      );

      expect(onLeaseLost).toHaveBeenCalledOnce();
      expect(ownsExecutionLease(executionId)).toBe(false);
      await expect(
        getExecutionStore(executionId).writeMeta({
          timestamp: '2026-07-16T12:01:00.000Z',
        }),
      ).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    });
    ownedExecutionIds.delete(executionId);
  });

  it('does not let a displaced continuation borrow a successor lease', async () => {
    const executionId = 'e86444' as ExecutionId;
    await acquire(executionId);
    const lateWriteGate = createDeferred();
    const lateWrite = Promise.resolve(
      captureOwnedExecutionLease(executionId)(async () => {
        await lateWriteGate.promise;
        expect(ownsExecutionLease(executionId)).toBe(false);
        markOwnedExecutionLeaseUndurable(executionId);
        abandonOwnedExecutionLease(executionId);
        await completeOwnedExecutionLease(executionId);
        expect(() =>
          captureOwnedExecutionLease(executionId)(() => undefined),
        ).toThrow(ExecutionLeaseLostError);
        await writeExecution(executionId);
      }),
    );
    await writeOrphanedLease(
      executionId,
      '00000000-0000-4000-8000-000000000006',
    );
    await acquireResumedExecutionLease(executionId);

    lateWriteGate.resolve();
    await expect(lateWrite).rejects.toBeInstanceOf(ExecutionLeaseLostError);

    await captureOwnedExecutionLease(executionId)(() =>
      getExecutionStore(executionId).writeMeta({
        timestamp: '2026-07-16T12:01:00.000Z',
      }),
    );
    await expect(
      getExecutionStore(executionId).readMeta(),
    ).resolves.toMatchObject({
      timestamp: '2026-07-16T12:01:00.000Z',
    });
  });

  it('does not let a delayed lifecycle root capture a successor lease', async () => {
    const executionId = 'e86445' as ExecutionId;
    await acquire(executionId);
    const runWithFirstOwner = captureOwnedExecutionLease(executionId);
    const firstOwnerPaused = createDeferred();
    const delayedCapture = Promise.resolve(
      runWithFirstOwner(async () => {
        await firstOwnerPaused.promise;
        return captureOwnedExecutionLeaseIfPresent(executionId);
      }),
    );
    await writeOrphanedLease(
      executionId,
      '00000000-0000-4000-8000-000000000007',
    );
    await acquireResumedExecutionLease(executionId);

    firstOwnerPaused.resolve();
    await expect(delayedCapture).rejects.toBeInstanceOf(
      ExecutionLeaseLostError,
    );
    expect(ownsExecutionLease(executionId)).toBe(true);
  });

  it('rejects unscoped writes while another owner has a lease', async () => {
    const executionId = 'e86446' as ExecutionId;
    await writeForeignLease(executionId);

    await expect(writeExecution(executionId)).rejects.toBeInstanceOf(
      ExecutionLeaseLostError,
    );
  });

  it('rejects validation when release starts during its record read', async () => {
    const executionId = 'e86443' as ExecutionId;
    await acquire(executionId);
    const read = gateNextLeaseRead();

    const validation = validateOwnedExecutionLease(executionId);
    await read.started;
    const release = releaseOwnedExecutionLease(executionId);
    read.release();

    await expect(validation).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    await release;
    ownedExecutionIds.delete(executionId);
  });

  it('refuses acquisition while maintenance holds the claim, then frees it', async () => {
    const executionId = 'f8644f' as ExecutionId;
    const deletionPaused = createDeferred();
    const deletionStarted = createDeferred();
    const deletion = runWithInactiveExecutionLease(executionId, async () => {
      deletionStarted.resolve();
      await deletionPaused.promise;
      return 'removed';
    });
    await deletionStarted.promise;

    // Maintenance is itself a claim held by this live process.
    await expect(
      acquireResumedExecutionLease(executionId),
    ).rejects.toMatchObject({
      name: 'ExecutionLeaseActiveError',
      provable: true,
    });

    deletionPaused.resolve();
    await expect(deletion).resolves.toEqual({
      status: 'performed',
      value: 'removed',
    });
    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'missing',
    });
    await acquire(executionId);
    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'owned',
    });
  });

  it('keeps a locally owned execution active whatever its record claims', async () => {
    const executionId = 'f86440' as ExecutionId;
    await acquire(executionId);
    const persisted = JSON.parse(
      await StorageFS.read(executionLeasePath(executionId)),
    ) as { ownerToken: string };
    // Even a record naming a dead instance never lets maintenance reap the
    // live local owner: token identity short-circuits before any probe.
    await writeOrphanedLease(executionId, persisted.ownerToken);
    const operation = vi.fn(async () => 'removed');

    await expect(
      runWithInactiveExecutionLease(executionId, operation),
    ).resolves.toMatchObject({ status: 'active' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('lets maintenance clear an orphaned displaced local owner', async () => {
    const executionId = 'f86441' as ExecutionId;
    await writeExecution(executionId);
    await acquire(executionId);
    await writeOrphanedLease(
      executionId,
      '00000000-0000-4000-8000-000000000005',
    );

    await expect(deleteExecution(executionId)).resolves.toMatchObject({
      status: 'deleted',
    });
    expect(ownsExecutionLease(executionId)).toBe(false);
    ownedExecutionIds.delete(executionId);
  });

  it('reports deleted, missing races, and protected IDs in bulk', async () => {
    const deletedId = 'a86440' as ExecutionId;
    const activeId = 'a86441' as ExecutionId;
    const beforeDelete = vi.fn(async () => {});
    await writeExecution(deletedId);
    await writeExecution(activeId);
    await writeForeignLease(activeId);

    await expect(deleteAllExecutions({ beforeDelete })).resolves.toEqual({
      deleted: [deletedId],
      active: [activeId],
      failed: [],
    });
    expect(beforeDelete).toHaveBeenCalledOnce();
    expect(beforeDelete).toHaveBeenCalledWith(deletedId);
  });

  it('preflights every lease before bulk deletion mutates storage', async () => {
    const validId = 'a86442' as ExecutionId;
    const malformedId = 'a86443' as ExecutionId;
    await writeExecution(validId);
    await writeExecution(malformedId);
    await StorageFS.ensureDir(WORKSPACE_STORAGE_LAYOUT.executionLeases);
    await StorageFS.writeAtomic(
      executionLeasePath(malformedId),
      '{"version":3}',
    );

    await expect(deleteAllExecutions()).rejects.toThrow('Failed to parse JSON');
    expect(await StorageFS.exists(`executions/${validId}`)).toBe(true);
    expect(await StorageFS.exists(`executions/${malformedId}`)).toBe(true);
  });

  it('reports ordinary bulk deletion failures alongside successful ids', async () => {
    const deletedId = 'a86444' as ExecutionId;
    const failedId = 'a86445' as ExecutionId;
    await writeExecution(deletedId);
    await writeExecution(failedId);
    const fs = platform().fs;
    const originalDelete = fs.delete.bind(fs);
    vi.spyOn(fs, 'delete').mockImplementation((target, options) => {
      if (target.includes(path.join('executions', failedId))) {
        return Promise.reject(new Error('permission denied'));
      }
      return originalDelete(target, options);
    });

    await expect(deleteAllExecutions()).resolves.toEqual({
      deleted: [deletedId],
      active: [],
      failed: [{ executionId: failedId, message: 'permission denied' }],
    });
  });
});
