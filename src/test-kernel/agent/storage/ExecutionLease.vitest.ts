import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  acquireResumedExecutionLease,
  inspectExecutionLease,
  releaseOwnedExecutionLease,
  runWithExecutionDeletionGuard,
} from '@agent/storage/executionLease';
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
    ownedExecutionIds.delete(executionId);

    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'missing',
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
    const deletion = runWithExecutionDeletionGuard(executionId, async () => {
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
    });
  });
});
