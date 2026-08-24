import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearStoreCache,
  finalizeRun,
  getExecutionStore,
} from '@agent/storage';
import {
  deleteAllExecutions,
  deleteExecution,
} from '@agent/storage/executionListing';
import {
  ExecutionLeaseActiveError,
  ExecutionLeaseLostError,
  acquireFreshExecutionLease,
  acquireResumedExecutionLease,
  inspectExecutionLease,
  ownsExecutionLease,
  releaseOwnedExecutionLease,
  runWithInactiveExecutionLease,
  validateOwnedExecutionLease,
} from '@agent/storage/executionLease';
import { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { platform } from '@platform/platform';
import { RUN_OUTCOME, type ExecutionId } from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import {
  deadOwner,
  displaceLease,
  executionLeaseDir,
  executionLeasePath,
  legacyExecutionLeasePath,
  readLeaseRecords,
  startForeignInstance,
  writeForeignLease,
  writeLegacyPresenceLease,
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

/**
 * Gate one filesystem probe of lease state so a concurrent step can
 * interleave: `readFile` for a claim's content, `stat` for the own-file
 * existence check the write fence performs.
 */
function gateNextLeaseRead(operation: 'readFile' | 'stat' = 'readFile'): {
  started: Promise<void>;
  release: () => void;
} {
  const fs = platform().fs;
  const started = createDeferred();
  const gate = createDeferred();
  const gated = async <T>(run: () => Promise<T>): Promise<T> => {
    started.resolve();
    await gate.promise;
    return run();
  };
  if (operation === 'stat') {
    const original = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementationOnce((target) =>
      gated(() => original(target)),
    );
  } else {
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementationOnce((target) =>
      gated(() => original(target)),
    );
  }
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
      status: 'free',
    });
    await acquire(executionId);

    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'owned',
    });
  });

  it('fails closed when present lease state is malformed', async () => {
    const executionId = 'c8644c' as ExecutionId;
    await writeExecution(executionId);
    await StorageFS.ensureDir(executionLeaseDir(executionId));
    await StorageFS.writeAtomic(
      executionLeasePath(executionId),
      '{"version":3}',
    );

    await expect(deleteExecution(executionId)).rejects.toThrow(
      'Failed to parse JSON',
    );
    expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
  });

  it('retires a heartbeat (v1) tombstone on contact', async () => {
    const executionId = 'c8644d' as ExecutionId;
    await writeExecution(executionId);
    await StorageFS.ensureDir(WORKSPACE_STORAGE_LAYOUT.executionLeases);
    await StorageFS.writeAtomic(
      legacyExecutionLeasePath(executionId),
      '{"version":1,"executionId":"c8644d","ownerToken":"00000000-0000-4000-8000-000000000009","acquiredAt":1,"heartbeatAt":1}',
    );

    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'free',
    });
    expect(await StorageFS.exists(legacyExecutionLeasePath(executionId))).toBe(
      false,
    );
    await expect(deleteExecution(executionId)).resolves.toMatchObject({
      status: 'deleted',
    });
  });

  it('rejects a presence-socket (v2) record whose token is not a UUID', async () => {
    const executionId = 'c86450' as ExecutionId;
    await StorageFS.ensureDir(WORKSPACE_STORAGE_LAYOUT.executionLeases);
    await StorageFS.writeAtomic(
      legacyExecutionLeasePath(executionId),
      JSON.stringify({
        version: 2,
        executionId,
        ownerToken: 'not-a-uuid',
        acquiredAt: 1,
        owner: {
          instanceId: 'x',
          socketPath: '/tmp/x.sock',
          pid: process.pid,
          hostname: os.hostname(),
        },
      }),
    );

    await expect(inspectExecutionLease(executionId)).rejects.toThrow(
      'Failed to parse JSON',
    );
  });

  it('keeps a v2 shadow record beside its own claim for 0.40.4 readers', async () => {
    const executionId = 'c86451' as ExecutionId;
    await acquire(executionId);

    const [record] = await readLeaseRecords(executionId);
    await expect(
      StorageFS.readJson(legacyExecutionLeasePath(executionId)),
    ).resolves.toMatchObject({
      version: 2,
      executionId,
      ownerToken: record!.ownerToken,
      owner: {
        instanceId: record!.ownerToken,
        pid: process.pid,
        hostname: os.hostname(),
      },
    });
    // The shadow is the claim's, not a second claim.
    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'owned',
    });

    await releaseOwnedExecutionLease(executionId);
    ownedExecutionIds.delete(executionId);
    expect(await StorageFS.exists(legacyExecutionLeasePath(executionId))).toBe(
      false,
    );
    expect(
      await StorageFS.readDir(WORKSPACE_STORAGE_LAYOUT.executionLeases),
    ).toEqual([]);
  });

  it('proves a presence-socket (v2) record by pid: dead is freed, live is kept', async () => {
    const deadId = 'c8644e' as ExecutionId;
    const liveId = 'c8644f' as ExecutionId;
    await writeExecution(deadId);
    await writeLegacyPresenceLease(deadId, await deadOwner());
    const foreign = await startForeignInstance();
    try {
      await writeLegacyPresenceLease(liveId, foreign.owner);

      await expect(inspectExecutionLease(deadId)).resolves.toEqual({
        status: 'free',
      });
      await expect(deleteExecution(deadId)).resolves.toMatchObject({
        status: 'deleted',
      });
      expect(await StorageFS.exists(legacyExecutionLeasePath(deadId))).toBe(
        false,
      );

      // No identity was ever recorded for a v2 owner, so a running pid is
      // unprovable: every automatic path refuses it while the pid exists.
      await expect(inspectExecutionLease(liveId)).resolves.toEqual({
        status: 'held',
        owner: { ...foreign.owner, processStart: null },
      });
      await expect(acquireResumedExecutionLease(liveId)).rejects.toMatchObject({
        name: 'ExecutionLeaseActiveError',
        owner: { pid: foreign.owner.pid },
      });
      expect(await StorageFS.exists(legacyExecutionLeasePath(liveId))).toBe(
        true,
      );
    } finally {
      await foreign.shutdown();
    }
    await expect(inspectExecutionLease(liveId)).resolves.toEqual({
      status: 'free',
    });
  });

  it('classifies a live pid whose identity differs from the record as orphaned', async () => {
    const executionId = 'b8644e' as ExecutionId;
    const foreign = await startForeignInstance();
    try {
      await writeForeignLease(executionId, undefined, {
        ...foreign.owner,
        processStart: `${foreign.owner.processStart}:reused`,
      });

      await expect(inspectExecutionLease(executionId)).resolves.toEqual({
        status: 'free',
      });
    } finally {
      await foreign.shutdown();
    }
  });

  it('classifies a killed owner as orphaned once its pid is gone', async () => {
    const executionId = 'b8644d' as ExecutionId;
    const foreign = await startForeignInstance();
    await writeForeignLease(executionId, undefined, foreign.owner);

    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'held',
      owner: foreign.owner,
    });
    await foreign.shutdown();
    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'free',
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
      label: 'a live pid whose identity cannot be read',
      owner: async () => {
        fakeProcesses().setIdentity(process.pid, undefined);
        return { pid: process.pid, processStart: '1', hostname: os.hostname() };
      },
    },
  ])(
    'treats $label as held until the user deletes the run',
    async ({ owner }) => {
      const executionId = 'b8644f' as ExecutionId;
      const record = await owner();
      await writeExecution(executionId);
      await writeForeignLease(executionId, undefined, record);
      const operation = vi.fn(async () => 'removed');

      await expect(inspectExecutionLease(executionId)).resolves.toEqual({
        status: 'held',
        owner: record,
      });
      await expect(
        runWithInactiveExecutionLease(executionId, operation),
      ).resolves.toEqual({ status: 'active', owner: record });
      expect(operation).not.toHaveBeenCalled();
      await expect(acquireResumedExecutionLease(executionId)).rejects.toThrow(
        `Execution ${executionId} is held by another TeXRA process (pid ${record.pid} on ${record.hostname}).`,
      );
      expect(await StorageFS.exists(executionLeasePath(executionId))).toBe(
        true,
      );

      // Only the user's explicit deletion reaps an unprovable owner.
      await expect(deleteExecution(executionId)).resolves.toMatchObject({
        status: 'deleted',
      });
      expect(await StorageFS.exists(executionLeasePath(executionId))).toBe(
        false,
      );
      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(false);
    },
  );

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
    expect((await StorageFS.readDir('.')).map(([name]) => name)).not.toContain(
      'executionLocks',
    );
    // One directory per execution, one complete file per claim (plus the
    // winner's v2 shadow): the loser unlinked its own file and nothing else
    // was ever renamed or rewritten.
    expect(
      (await StorageFS.readDir(WORKSPACE_STORAGE_LAYOUT.executionLeases))
        .map(([name]) => name)
        .sort(),
    ).toEqual([executionId, `${executionId}.json`]);
    const [record, ...rest] = await readLeaseRecords(executionId);
    expect(rest).toEqual([]);
    expect(
      (await StorageFS.readDir(executionLeaseDir(executionId))).map(
        ([name]) => name,
      ),
    ).toEqual([`${record!.ownerToken}.json`]);
  });

  it('resolves two claimants that each see the other in favour of the smaller token', async () => {
    const executionId = 'b86455' as ExecutionId;
    // Hold both publishes until both claimants have read an empty directory,
    // so each one's post-publish read sees the other's file and the
    // tie-break decides rather than the first publisher simply winning.
    const fs = platform().fs;
    const originalPublish = fs.publishFile.bind(fs);
    const bothPublishing = createDeferred();
    let publishes = 0;
    vi.spyOn(fs, 'publishFile').mockImplementation(async (target, content) => {
      publishes += 1;
      if (publishes === 2) bothPublishing.resolve();
      if (publishes <= 2) await bothPublishing.promise;
      return originalPublish(target, content);
    });

    const outcomes = await Promise.allSettled([
      acquireFreshExecutionLease(executionId),
      acquireFreshExecutionLease(executionId),
    ]);
    ownedExecutionIds.add(executionId);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: 'acquired' },
    ]);
    const loss = outcomes.find((o) => o.status === 'rejected');
    expect(loss?.reason).toBeInstanceOf(ExecutionLeaseActiveError);
    expect(loss?.reason).toMatchObject({ owner: { pid: process.pid } });
    const [winner, ...rest] = await readLeaseRecords(executionId);
    expect(rest).toEqual([]);
    expect(
      await StorageFS.exists(
        executionLeasePath(executionId, winner!.ownerToken),
      ),
    ).toBe(true);
    expect(ownsExecutionLease(executionId)).toBe(true);
  });

  it('keeps re-reading while a larger live competitor withdraws, never yielding to it', async () => {
    const executionId = 'b86456' as ExecutionId;
    // Every v4 UUID sorts below this token, so the claimant is the smaller
    // one and must win; the competitor is a live process that appears
    // between the claimant's pre-publish read and its post-publish read,
    // then withdraws only after the claimant has re-read several times.
    const largerToken = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const fs = platform().fs;
    const originalPublish = fs.publishFile.bind(fs);
    const originalReadDir = fs.readDirectory.bind(fs);
    let published = false;
    let readsAfterPublish = 0;
    vi.spyOn(fs, 'publishFile').mockImplementation(async (target, content) => {
      await writeForeignLease(executionId, largerToken);
      published = true;
      return originalPublish(target, content);
    });
    vi.spyOn(fs, 'readDirectory').mockImplementation(async (target) => {
      if (published && target.endsWith(executionId)) {
        readsAfterPublish += 1;
        if (readsAfterPublish === 3) {
          await StorageFS.delete(executionLeasePath(executionId, largerToken));
        }
      }
      return originalReadDir(target);
    });

    await expect(acquireFreshExecutionLease(executionId)).resolves.toBe(
      'acquired',
    );
    ownedExecutionIds.add(executionId);
    expect(readsAfterPublish).toBe(3);
    const [record, ...rest] = await readLeaseRecords(executionId);
    expect(rest).toEqual([]);
    expect(record!.ownerToken < largerToken).toBe(true);
    expect(ownsExecutionLease(executionId)).toBe(true);
  });

  it('never removes a live claim published after a stale read of a dead one', async () => {
    const executionId = 'b86454' as ExecutionId;
    const liveToken = '00000000-0000-4000-8000-00000000000b';
    await writeOrphanedLease(executionId);
    const staleRead = gateNextLeaseRead();

    const claim = acquireResumedExecutionLease(executionId);
    await staleRead.started;
    // Between the stale read of the dead record and its removal, another
    // process claims the execution. Its file has its own name, so removing
    // the dead one cannot touch it, and the late claimant backs out.
    await writeForeignLease(executionId, liveToken);
    staleRead.release();

    await expect(claim).rejects.toMatchObject({
      name: 'ExecutionLeaseActiveError',
    });
    expect(ownsExecutionLease(executionId)).toBe(false);
    expect(await StorageFS.exists(executionLeasePath(executionId))).toBe(false);
    expect(
      await StorageFS.exists(executionLeasePath(executionId, liveToken)),
    ).toBe(true);
    expect(await readLeaseRecords(executionId)).toHaveLength(1);
  });

  it('rejects resume while another live owner holds the lease', async () => {
    const executionId = 'd8644d' as ExecutionId;
    await writeForeignLease(executionId);

    await expect(
      acquireResumedExecutionLease(executionId),
    ).rejects.toBeInstanceOf(ExecutionLeaseActiveError);
  });

  it('starts a resume only after the previous generation has released its lease', async () => {
    const executionId = 'd8645a' as ExecutionId;
    const events = new SessionEventHub();
    const registry = new ExecutionRegistry({
      streamStatus: new StreamStatusMachine(events),
      events,
      releaseRootExecutionLease: async () => undefined,
    });
    const readToken = async (): Promise<string> => {
      const [record, ...rest] = await readLeaseRecords(executionId);
      expect(rest).toEqual([]);
      return record!.ownerToken;
    };
    const disposing = createDeferred();
    let resumeStarted = false;

    try {
      const first = registry.launchExecution(executionId, async () => {
        await acquireFreshExecutionLease(executionId);
        await disposing.promise;
        await releaseOwnedExecutionLease(executionId);
      });
      await vi.waitFor(() =>
        expect(ownsExecutionLease(executionId)).toBe(true),
      );
      const firstToken = await readToken();

      const second = registry.launchExecution(executionId, async () => {
        resumeStarted = true;
        return acquireResumedExecutionLease(executionId);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The first generation is still disposing: the resume waits and the
      // record on disk is still the first generation's, so no second lease
      // was minted under it.
      expect(resumeStarted).toBe(false);
      await expect(readToken()).resolves.toBe(firstToken);

      disposing.resolve();
      await first;
      await expect(second).resolves.toBe('acquired');
      ownedExecutionIds.add(executionId);
      await expect(readToken()).resolves.not.toBe(firstToken);
    } finally {
      registry.dispose();
    }
  });

  it('surfaces a transient resume validation failure without dropping ownership', async () => {
    const executionId = 'd86451' as ExecutionId;
    await acquire(executionId);
    vi.spyOn(platform().fs, 'stat').mockRejectedValueOnce(
      new Error('temporary filesystem failure'),
    );

    await expect(acquireResumedExecutionLease(executionId)).rejects.toThrow(
      'temporary filesystem failure',
    );
    expect(ownsExecutionLease(executionId)).toBe(true);
  });

  it('keeps resumed ownership live until terminal lifecycle release', async () => {
    const executionId = 'd86440' as ExecutionId;
    await writeExecution(executionId);
    await acquire(executionId);

    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'owned',
    });
    await finalizeRun({
      executionId,
      outcome: RUN_OUTCOME.COMPLETED,
      flowRecord: 'preserve',
    });
    await releaseOwnedExecutionLease(executionId);
    ownedExecutionIds.delete(executionId);

    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'free',
    });
  });

  it('stops claiming ownership even when the lease deletion fails', async () => {
    const executionId = 'd86444' as ExecutionId;
    const deletionError = new Error('lease deletion failed');
    await acquire(executionId);
    vi.spyOn(StorageFS, 'delete').mockRejectedValueOnce(deletionError);

    await expect(releaseOwnedExecutionLease(executionId)).rejects.toBe(
      deletionError,
    );
    ownedExecutionIds.delete(executionId);

    expect(ownsExecutionLease(executionId)).toBe(false);
    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'held',
      owner: expect.objectContaining({ pid: process.pid }),
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
      status: 'held',
    });
  });

  it('fences an execution-store write immediately after takeover', async () => {
    const executionId = 'e86440' as ExecutionId;
    await acquire(executionId);
    await displaceLease(executionId, '00000000-0000-4000-8000-000000000004');

    await expect(writeExecution(executionId)).rejects.toBeInstanceOf(
      ExecutionLeaseLostError,
    );

    expect(ownsExecutionLease(executionId)).toBe(false);
    await expect(
      getExecutionStore(executionId).writeMeta({
        timestamp: '2026-07-16T12:01:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    ownedExecutionIds.delete(executionId);
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
    const read = gateNextLeaseRead('stat');

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
      owner: { pid: process.pid },
    });

    deletionPaused.resolve();
    await expect(deletion).resolves.toEqual({
      status: 'performed',
      value: 'removed',
    });
    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'free',
    });
    await acquire(executionId);
    await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
      status: 'owned',
    });
  });

  it('keeps a locally owned execution active whatever its record claims', async () => {
    const executionId = 'f86440' as ExecutionId;
    await acquire(executionId);
    const [persisted] = await readLeaseRecords(executionId);
    // Even a record naming a dead instance never lets maintenance reap the
    // live local owner: token identity short-circuits before any probe.
    await writeOrphanedLease(executionId, persisted!.ownerToken);
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
    await displaceLease(
      executionId,
      '00000000-0000-4000-8000-000000000005',
      await deadOwner(),
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
    await StorageFS.ensureDir(executionLeaseDir(malformedId));
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
