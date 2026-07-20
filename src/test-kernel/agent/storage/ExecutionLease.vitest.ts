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
  EXECUTION_LEASE_STALE_MS,
  ExecutionLeaseActiveError,
  ExecutionLeaseLostError,
  abandonOwnedExecutionLease,
  acquireResumedExecutionLease,
  completeOwnedExecutionLease,
  inspectExecutionLease,
  markOwnedExecutionLeaseUndurable,
  onOwnedExecutionLeaseLost,
  ownsExecutionLease,
  releaseOwnedExecutionLease,
  runWithInactiveExecutionLease,
  waitForOwnedExecutionLeaseRelease,
} from '@agent/storage/executionLease';
import { platform } from '@platform/platform';
import { EXECUTION_STATUS, type ExecutionId } from '@shared/schemas';
import { StorageFS } from '@utils/files';

const ownedExecutionIds = new Set<ExecutionId>();

function leasePath(executionId: ExecutionId): string {
  return `executionLeases/${executionId}.json`;
}

async function writeForeignLease(
  executionId: ExecutionId,
  heartbeatAt: number,
  ownerToken = '00000000-0000-4000-8000-000000000001',
): Promise<void> {
  await StorageFS.ensureDir('executionLeases');
  await StorageFS.writeAtomic(
    leasePath(executionId),
    JSON.stringify({
      version: 1,
      executionId,
      ownerToken,
      acquiredAt: heartbeatAt,
      heartbeatAt,
    }),
  );
}

async function writeExecution(executionId: ExecutionId): Promise<void> {
  await getExecutionStore(executionId).writeMeta({
    timestamp: '2026-07-16T12:00:00.000Z',
  });
}

async function acquire(executionId: ExecutionId): Promise<void> {
  ownedExecutionIds.add(executionId);
  await acquireResumedExecutionLease(executionId);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...ownedExecutionIds].map(releaseOwnedExecutionLease));
  ownedExecutionIds.clear();
  await StorageFS.delete('executionLeases', { recursive: true }).catch(
    () => {},
  );
  await StorageFS.delete('executions', { recursive: true }).catch(() => {});
  clearStoreCache();
});

beforeEach(() => {
  clearStoreCache();
});

describe('cross-process execution leases', () => {
  it('protects a freshly leased execution from single deletion', async () => {
    const executionId = 'a8644a' as ExecutionId;
    await writeExecution(executionId);
    await writeForeignLease(executionId, Date.now());

    await expect(deleteExecution(executionId)).resolves.toMatchObject({
      status: 'active',
      executionId,
    });
    expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
  });

  it('takes over a stale lease after the explicit horizon', async () => {
    const executionId = 'b8644b' as ExecutionId;
    const now = Date.now();
    await writeForeignLease(executionId, now - EXECUTION_LEASE_STALE_MS - 1);

    await acquire(executionId);

    await expect(
      inspectExecutionLease(executionId, now),
    ).resolves.toMatchObject({ status: 'owned' });
  });

  it('fails closed when present lease state is malformed', async () => {
    const executionId = 'c8644c' as ExecutionId;
    await writeExecution(executionId);
    await StorageFS.ensureDir('executionLeases');
    await StorageFS.writeAtomic(leasePath(executionId), '{"version":1}');

    await expect(deleteExecution(executionId)).rejects.toThrow(
      'Failed to parse JSON',
    );
    expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
  });

  it('rejects resume while another owner has a fresh lease', async () => {
    const executionId = 'd8644d' as ExecutionId;
    await writeForeignLease(executionId, Date.now());

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

  it('keeps resumed ownership live until terminal lifecycle release', async () => {
    const executionId = 'd86440' as ExecutionId;
    await writeExecution(executionId);
    await acquire(executionId);

    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'owned',
    });
    await finalizeExecution({
      executionId,
      terminalStatus: EXECUTION_STATUS.COMPLETED,
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

  it('stops heartbeats but preserves the lease after durability failure', async () => {
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

    markOwnedExecutionLeaseUndurable(executionId);
    await completeOwnedExecutionLease(executionId);
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
      Date.now(),
      '00000000-0000-4000-8000-000000000002',
    );

    await releaseOwnedExecutionLease(executionId);
    ownedExecutionIds.delete(executionId);

    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'foreign',
    });
  });

  it('fences the former owner when a heartbeat observes takeover', async () => {
    vi.useFakeTimers();
    const executionId = 'e8644f' as ExecutionId;
    try {
      await acquire(executionId);
      const onLeaseLost = vi.fn();
      onOwnedExecutionLeaseLost(executionId, onLeaseLost);
      await writeForeignLease(
        executionId,
        Date.now(),
        '00000000-0000-4000-8000-000000000003',
      );

      await vi.advanceTimersByTimeAsync(15_000);

      expect(onLeaseLost).toHaveBeenCalledOnce();
      expect(ownsExecutionLease(executionId)).toBe(false);
      ownedExecutionIds.delete(executionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences an execution-store write immediately after takeover', async () => {
    const executionId = 'e86440' as ExecutionId;
    await acquire(executionId);
    const onLeaseLost = vi.fn();
    onOwnedExecutionLeaseLost(executionId, onLeaseLost);
    await writeForeignLease(
      executionId,
      Date.now(),
      '00000000-0000-4000-8000-000000000004',
    );

    await expect(
      getExecutionStore(executionId).writeMeta({
        timestamp: '2026-07-16T12:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ExecutionLeaseLostError);

    expect(onLeaseLost).toHaveBeenCalledOnce();
    expect(ownsExecutionLease(executionId)).toBe(false);
    await expect(
      getExecutionStore(executionId).writeMeta({
        timestamp: '2026-07-16T12:01:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    ownedExecutionIds.delete(executionId);
  });

  it('never overlaps heartbeat work for the same execution', async () => {
    const executionId = 'e86441' as ExecutionId;
    vi.useFakeTimers();
    let releaseHeartbeat = (): void => undefined;
    try {
      await acquire(executionId);
      const originalRunExclusive = platform().fileLocks.runExclusive.bind(
        platform().fileLocks,
      );
      const heartbeatGate = new Promise<void>((resolve) => {
        releaseHeartbeat = resolve;
      });
      const runExclusive = vi
        .spyOn(platform().fileLocks, 'runExclusive')
        .mockImplementation(async (lockPath, operation) => {
          await heartbeatGate;
          return originalRunExclusive(lockPath, operation);
        });

      await vi.advanceTimersByTimeAsync(15_000);
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
      expect(runExclusive).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(45_000);
      expect(runExclusive).toHaveBeenCalledOnce();
    } finally {
      releaseHeartbeat();
      vi.useRealTimers();
    }
  });

  it('serializes deletion with a racing lease acquisition', async () => {
    const executionId = 'f8644f' as ExecutionId;
    let allowDeletion: (() => void) | undefined;
    const deletionPaused = new Promise<void>((resolve) => {
      allowDeletion = resolve;
    });
    let deletionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      deletionStarted = resolve;
    });
    const deletion = runWithInactiveExecutionLease(executionId, async () => {
      deletionStarted?.();
      await deletionPaused;
      return 'removed';
    });
    await started;

    const acquisition = acquire(executionId);
    await Promise.resolve();
    expect(await StorageFS.exists(leasePath(executionId))).toBe(false);

    allowDeletion?.();
    await expect(deletion).resolves.toEqual({
      status: 'performed',
      value: 'removed',
    });
    await acquisition;
    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'owned',
    });
  });

  it('keeps locally owned execution active even when its heartbeat is old', async () => {
    const executionId = 'f86440' as ExecutionId;
    await acquire(executionId);
    const persisted = JSON.parse(
      await StorageFS.read(leasePath(executionId)),
    ) as { ownerToken: string };
    await writeForeignLease(
      executionId,
      Date.now() - EXECUTION_LEASE_STALE_MS - 1,
      persisted.ownerToken,
    );
    const operation = vi.fn(async () => 'removed');

    await expect(
      runWithInactiveExecutionLease(executionId, operation),
    ).resolves.toMatchObject({ status: 'active' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('lets locked maintenance clear a stale displaced local owner', async () => {
    const executionId = 'f86441' as ExecutionId;
    await writeExecution(executionId);
    await acquire(executionId);
    await writeForeignLease(
      executionId,
      Date.now() - EXECUTION_LEASE_STALE_MS - 1,
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
    await writeExecution(deletedId);
    await writeExecution(activeId);
    await writeForeignLease(activeId, Date.now());

    await expect(deleteAllExecutions()).resolves.toEqual({
      deleted: [deletedId],
      notFound: [],
      active: [activeId],
      failed: [],
    });
  });

  it('preflights every lease before bulk deletion mutates storage', async () => {
    const validId = 'a86442' as ExecutionId;
    const malformedId = 'a86443' as ExecutionId;
    await writeExecution(validId);
    await writeExecution(malformedId);
    await StorageFS.ensureDir('executionLeases');
    await StorageFS.writeAtomic(leasePath(malformedId), '{"version":1}');

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
    const deleteSpy = vi
      .spyOn(fs, 'delete')
      .mockImplementation((target, options) => {
        if (target.includes(`executions/${failedId}`)) {
          return Promise.reject(new Error('permission denied'));
        }
        return originalDelete(target, options);
      });

    try {
      await expect(deleteAllExecutions()).resolves.toEqual({
        deleted: [deletedId],
        notFound: [],
        active: [],
        failed: [{ executionId: failedId, message: 'permission denied' }],
      });
    } finally {
      deleteSpy.mockRestore();
    }
  });
});
