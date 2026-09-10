import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';

import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearStoreCache,
  finalizeRun,
  getExecutionStore,
} from '@agent/storage';
import {
  ExecutionLeaseActiveError,
  ExecutionLeaseLostError,
  ExecutionLeaseSchema,
  acquireFreshExecutionLease,
  acquireResumedExecutionLease,
  inspectExecutionLease,
  ownsExecutionLease,
  releaseOwnedExecutionLease,
  runWithInactiveExecutionLease,
  validateOwnedExecutionLease,
} from '@agent/storage/executionLease';
import type { LeaseOwnerRecord } from '@agent/storage/leaseOwnerLiveness';
import { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import { createSessionApprovals } from '@agent/runtime/streamApprovalQueue';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { platform } from '@platform/platform';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { RUN_OUTCOME, type ExecutionId } from '@shared/schemas';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { createDeferred } from '@test/support/asyncTestUtils';
import type { FakeProcesses } from '@test/support/FakePlatform';
import { StorageFS } from '@utils/files/storageFS';
import type { z } from 'zod';

/**
 * A lease owner that is never this process: local ownership always uses a
 * freshly generated UUID, so a fixed token reads back as foreign ownership.
 */
const FOREIGN_OWNER_TOKEN = '00000000-0000-4000-8000-000000000001';

/** Storage-relative directory holding an execution's claim files. */
function executionLeaseDir(executionId: string): string {
  return `${WORKSPACE_STORAGE_LAYOUT.executionLeases}/${executionId}`;
}

/** Storage-relative path of one claim file (the foreign fixture's by default). */
function executionLeasePath(
  executionId: string,
  ownerToken: string = FOREIGN_OWNER_TOKEN,
): string {
  return `${executionLeaseDir(executionId)}/${ownerToken}.json`;
}

/** Every claim record currently published for an execution, in token order. */
async function readLeaseRecords(
  executionId: string,
): Promise<z.infer<typeof ExecutionLeaseSchema>[]> {
  const entries = await StorageFS.readDir(executionLeaseDir(executionId)).catch(
    () => [] as [string, number][],
  );
  const records = await Promise.all(
    entries
      .map(([name]) => name)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) =>
        StorageFS.readJson(
          `${executionLeaseDir(executionId)}/${name}`,
          ExecutionLeaseSchema,
        ),
      ),
  );
  return records;
}

interface ForeignInstance {
  readonly owner: LeaseOwnerRecord;
  /** Kill the other process; its pid then proves dead for real. */
  readonly shutdown: () => Promise<void>;
}

/**
 * Spawn an idling child and read its start identity through the real port,
 * on every platform the port supports. The child never keeps the worker
 * alive: its stdio is not piped and its handle is unreferenced, and
 * `sharedForeign` kills it at exit.
 */
async function spawnIdleChild(): Promise<{
  child: ChildProcess;
  pid: number;
  processStart: string;
}> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error('Failed to spawn a child process');
  const processStart = await nodeProcesses.identity(pid);
  if (processStart === undefined) {
    child.kill('SIGKILL');
    throw new Error(`Cannot read the start identity of child ${pid}`);
  }
  return { child, pid, processStart };
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  child.kill('SIGKILL');
  await exited;
}

/**
 * A real, idling child process standing in for another TeXRA instance. Its
 * liveness is proven the production way: the pid exists and the start time
 * read through the real process port matches the one recorded here.
 */
async function startForeignInstance(): Promise<ForeignInstance> {
  const { child, pid, processStart } = await spawnIdleChild();
  return {
    owner: { pid, processStart, hostname: os.hostname() },
    shutdown: () => killAndWait(child),
  };
}

/**
 * One shared idle child serves every plain foreign-lease fixture in a worker;
 * it is killed when the worker exits. Tests that need to kill the owner start
 * their own instance.
 */
let sharedForeignInstance: Promise<ForeignInstance> | undefined;

function sharedForeign(): Promise<ForeignInstance> {
  sharedForeignInstance ??= startForeignInstance().then((instance) => {
    process.once('exit', () => {
      try {
        process.kill(instance.owner.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    });
    return instance;
  });
  return sharedForeignInstance;
}

let exitedChild: Promise<LeaseOwnerRecord> | undefined;

/**
 * An owner the kernel proves dead: a child that was spawned, whose start time
 * was read while it ran, and that has since exited (ESRCH on `kill(pid, 0)`).
 */
function deadOwner(): Promise<LeaseOwnerRecord> {
  exitedChild ??= (async () => {
    const { child, pid, processStart } = await spawnIdleChild();
    await killAndWait(child);
    return { pid, processStart, hostname: os.hostname() };
  })();
  return exitedChild;
}

async function writeLeaseFixture(
  executionId: string,
  owner: LeaseOwnerRecord,
  ownerToken: string,
): Promise<void> {
  const lease = ExecutionLeaseSchema.parse({
    version: 3,
    executionId,
    ownerToken,
    acquiredAt: Date.now(),
    owner,
  });
  await StorageFS.ensureDir(executionLeaseDir(executionId));
  await StorageFS.writeAtomic(
    executionLeasePath(executionId, ownerToken),
    JSON.stringify(lease),
  );
}

/**
 * Persist a lease held by another live process, validated against the
 * production lease schema so a schema change breaks every fixture in one
 * place. The recorded owner is a real process whose liveness is proven.
 */
async function writeForeignLease(
  executionId: string,
  ownerToken: string = FOREIGN_OWNER_TOKEN,
  owner?: LeaseOwnerRecord,
): Promise<void> {
  await writeLeaseFixture(
    executionId,
    owner ?? (await sharedForeign()).owner,
    ownerToken,
  );
}

/**
 * Model a reclaim performed elsewhere: every claim file on disk is
 * removed and `owner`'s claim published
 * in its place. Only this (a user's explicit reclaim) ever removes another
 * process's claim; a claim published beside an existing one never displaces
 * it.
 */
async function displaceLease(
  executionId: string,
  ownerToken: string,
  owner?: LeaseOwnerRecord,
): Promise<void> {
  await StorageFS.delete(executionLeaseDir(executionId), { recursive: true });
  await writeForeignLease(executionId, ownerToken, owner);
}

/** Persist a lease whose owner is provably dead, so the record is reclaimable. */
async function writeOrphanedLease(
  executionId: string,
  ownerToken: string = FOREIGN_OWNER_TOKEN,
): Promise<void> {
  await writeLeaseFixture(executionId, await deadOwner(), ownerToken);
}

const ownedExecutionIds = new Set<ExecutionId>();

async function writeExecution(executionId: ExecutionId): Promise<void> {
  await getExecutionStore(executionId).write('lease-probe', {
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
  ])('treats $label as held without a death proof', async ({ owner }) => {
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
    expect(await StorageFS.exists(executionLeasePath(executionId))).toBe(true);
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
    expect((await StorageFS.readDir('.')).map(([name]) => name)).not.toContain(
      'executionLocks',
    );
    // One directory per execution, one complete file per claim: the loser
    // unlinked its own file and nothing was renamed or rewritten.
    expect(
      (await StorageFS.readDir(WORKSPACE_STORAGE_LAYOUT.executionLeases))
        .map(([name]) => name)
        .sort(),
    ).toEqual([executionId]);
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
    const registry = new ExecutionRegistry({
      streamStatus: new StreamStatusMachine(
        () => {},
        () => {},
      ),
      publish: () => {},
      approvals: createSessionApprovals({ setApprovalBypassState() {} }),
      publishResult: () => {},
      releaseRootExecutionLease: () => Effect.void,
      finalizeExecution: (input) =>
        Effect.succeed({ ok: true, outcome: input.outcome }),
    });
    const readToken = async (): Promise<string> => {
      const [record, ...rest] = await readLeaseRecords(executionId);
      expect(rest).toEqual([]);
      return record!.ownerToken;
    };
    const disposing = createDeferred();
    let resumeStarted = false;

    try {
      const first = Effect.runPromise(
        registry.launchExecution(
          executionId,
          Effect.promise(async () => {
            await acquireFreshExecutionLease(executionId);
            await disposing.promise;
            await releaseOwnedExecutionLease(executionId);
          }),
        ),
      );
      await vi.waitFor(() =>
        expect(ownsExecutionLease(executionId)).toBe(true),
      );
      const firstToken = await readToken();

      const second = Effect.runPromise(
        registry.launchExecution(
          executionId,
          Effect.promise(async () => {
            resumeStarted = true;
            return acquireResumedExecutionLease(executionId);
          }),
        ),
      );
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
    const session = createProcessSession();
    publishTestRunStart(session, `stream:${executionId}`, executionId);
    await session.settlePublications();
    await Effect.runPromise(
      finalizeRun(session, {
        executionId,
        outcome: RUN_OUTCOME.COMPLETED,
        flowRecord: 'preserve',
      }),
    );
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
      getExecutionStore(executionId).write('lease-probe', {
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
});
