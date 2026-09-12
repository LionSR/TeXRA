import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';

import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { finalizeRun } from '@agent/storage';
import {
  RunLeaseActiveError,
  RunLeaseLostError,
  RunLeaseSchema,
  acquireFreshRunLease,
  acquireResumedRunLease,
  inspectRunLease,
  ownsRunLease,
  releaseOwnedRunLease,
  runWithInactiveRunLease,
  validateOwnedRunLease,
} from '@agent/storage/runLease';
import type { LeaseOwnerRecord } from '@agent/storage/leaseOwnerLiveness';
import { RunRegistry } from '@agent/runtime/runRegistry';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { platform } from '@platform/platform';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { RUN_OUTCOME, type RunId } from '@shared/schemas';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { createDeferred } from '@test/support/asyncTestUtils';
import { StorageFS } from '@utils/files/storageFS';
import type { z } from 'zod';

/**
 * A lease owner that is never this process: local ownership always uses a
 * freshly generated UUID, so a fixed token reads back as foreign ownership.
 */
const FOREIGN_OWNER_TOKEN = '00000000-0000-4000-8000-000000000001';

/** Storage-relative directory holding a run's claim files. */
function runLeaseDir(runId: string): string {
  return `${WORKSPACE_STORAGE_LAYOUT.runLeases}/${runId}`;
}

/** Storage-relative path of one claim file (the foreign fixture's by default). */
function runLeasePath(
  runId: string,
  ownerToken: string = FOREIGN_OWNER_TOKEN,
): string {
  return `${runLeaseDir(runId)}/${ownerToken}.json`;
}

/** Every claim record currently published for a run, in token order. */
async function readLeaseRecords(
  runId: string,
): Promise<z.infer<typeof RunLeaseSchema>[]> {
  const entries = await StorageFS.readDir(runLeaseDir(runId)).catch(
    () => [] as [string, number][],
  );
  const records = await Promise.all(
    entries
      .map(([name]) => name)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) =>
        StorageFS.readJson(`${runLeaseDir(runId)}/${name}`, RunLeaseSchema),
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
  runId: string,
  owner: LeaseOwnerRecord,
  ownerToken: string,
): Promise<void> {
  const lease = RunLeaseSchema.parse({
    version: 3,
    runId,
    ownerToken,
    acquiredAt: Date.now(),
    owner,
  });
  await StorageFS.ensureDir(runLeaseDir(runId));
  await StorageFS.writeAtomic(
    runLeasePath(runId, ownerToken),
    JSON.stringify(lease),
  );
}

/**
 * Persist a lease held by another live process, validated against the
 * production lease schema so a schema change breaks every fixture in one
 * place. The recorded owner is a real process whose liveness is proven.
 */
async function writeForeignLease(
  runId: string,
  ownerToken: string = FOREIGN_OWNER_TOKEN,
  owner?: LeaseOwnerRecord,
): Promise<void> {
  await writeLeaseFixture(
    runId,
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
  runId: string,
  ownerToken: string,
  owner?: LeaseOwnerRecord,
): Promise<void> {
  await StorageFS.delete(runLeaseDir(runId), { recursive: true });
  await writeForeignLease(runId, ownerToken, owner);
}

/** Persist a lease whose owner is provably dead, so the record is reclaimable. */
async function writeOrphanedLease(
  runId: string,
  ownerToken: string = FOREIGN_OWNER_TOKEN,
): Promise<void> {
  await writeLeaseFixture(runId, await deadOwner(), ownerToken);
}

const ownedRunIds = new Set<RunId>();

/** Give the run a directory of its own on disk, the way its artifacts do. */
async function writeRun(runId: RunId): Promise<void> {
  await StorageFS.ensureDir(resolveRunStoragePath(runId));
  await StorageFS.write(
    resolveRunStoragePath(runId, 'lease-probe.json'),
    JSON.stringify({ timestamp: '2026-07-16T12:00:00.000Z' }),
  );
}

async function acquire(runId: RunId): Promise<void> {
  ownedRunIds.add(runId);
  await acquireResumedRunLease(runId);
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
  await Promise.all([...ownedRunIds].map(releaseOwnedRunLease));
  ownedRunIds.clear();
  await StorageFS.delete(WORKSPACE_STORAGE_LAYOUT.runLeases, {
    recursive: true,
  }).catch(() => {});
  await StorageFS.delete('executions', { recursive: true }).catch(() => {});
});

beforeEach(() => {});

describe('cross-process run leases', () => {
  it('takes over an orphaned lease whose owner is provably dead', async () => {
    const runId = 'b8644b' as RunId;
    await writeOrphanedLease(runId);

    await expect(inspectRunLease(runId)).resolves.toEqual({
      status: 'free',
    });
    await acquire(runId);

    await expect(inspectRunLease(runId)).resolves.toMatchObject({
      status: 'owned',
    });
  });

  it('classifies a live pid whose identity differs from the record as orphaned', async () => {
    const runId = 'b8644e' as RunId;
    const foreign = await startForeignInstance();
    try {
      await writeForeignLease(runId, undefined, {
        ...foreign.owner,
        processStart: `${foreign.owner.processStart}:reused`,
      });

      await expect(inspectRunLease(runId)).resolves.toEqual({
        status: 'free',
      });
    } finally {
      await foreign.shutdown();
    }
  });

  it('classifies a killed owner as orphaned once its pid is gone', async () => {
    const runId = 'b8644d' as RunId;
    const foreign = await startForeignInstance();
    await writeForeignLease(runId, undefined, foreign.owner);

    await expect(inspectRunLease(runId)).resolves.toEqual({
      status: 'held',
      owner: foreign.owner,
    });
    await foreign.shutdown();
    await expect(inspectRunLease(runId)).resolves.toEqual({
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
        const readIdentity = nodeProcesses.identity;
        vi.spyOn(nodeProcesses, 'identity').mockImplementation(async (pid) =>
          pid === process.pid ? undefined : readIdentity(pid),
        );
        vi.spyOn(nodeProcesses, 'selfIdentity').mockResolvedValue(undefined);
        return { pid: process.pid, processStart: '1', hostname: os.hostname() };
      },
    },
  ])('treats $label as held without a death proof', async ({ owner }) => {
    const runId = 'b8644f' as RunId;
    const record = await owner();
    await writeRun(runId);
    await writeForeignLease(runId, undefined, record);
    const operation = vi.fn(async () => 'removed');

    await expect(inspectRunLease(runId)).resolves.toEqual({
      status: 'held',
      owner: record,
    });
    await expect(runWithInactiveRunLease(runId, operation)).resolves.toEqual({
      status: 'active',
      owner: record,
    });
    expect(operation).not.toHaveBeenCalled();
    await expect(acquireResumedRunLease(runId)).rejects.toThrow(
      `Run ${runId} is held by another TeXRA process (pid ${record.pid} on ${record.hostname}).`,
    );
    expect(await StorageFS.exists(runLeasePath(runId))).toBe(true);
  });

  it('lets exactly one of two concurrent fresh claims win, with no lock directory', async () => {
    const runId = 'b86452' as RunId;
    const outcomes = await Promise.allSettled([
      acquireFreshRunLease(runId),
      acquireFreshRunLease(runId),
    ]);
    ownedRunIds.add(runId);

    const winners = outcomes.filter(
      (outcome) =>
        outcome.status === 'fulfilled' && outcome.value === 'acquired',
    );
    const losers = outcomes.filter(
      (outcome) =>
        outcome.status === 'rejected' &&
        outcome.reason instanceof RunLeaseActiveError,
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(ownsRunLease(runId)).toBe(true);
    expect((await StorageFS.readDir('.')).map(([name]) => name)).not.toContain(
      'executionLocks',
    );
    // One directory per run, one complete file per claim: the loser
    // unlinked its own file and nothing was renamed or rewritten.
    expect(
      (await StorageFS.readDir(WORKSPACE_STORAGE_LAYOUT.runLeases))
        .map(([name]) => name)
        .sort(),
    ).toEqual([runId]);
    const [record, ...rest] = await readLeaseRecords(runId);
    expect(rest).toEqual([]);
    expect(
      (await StorageFS.readDir(runLeaseDir(runId))).map(([name]) => name),
    ).toEqual([`${record!.ownerToken}.json`]);
  });

  it('resolves two claimants that each see the other in favour of the smaller token', async () => {
    const runId = 'b86455' as RunId;
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
      acquireFreshRunLease(runId),
      acquireFreshRunLease(runId),
    ]);
    ownedRunIds.add(runId);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: 'acquired' },
    ]);
    const loss = outcomes.find((o) => o.status === 'rejected');
    expect(loss?.reason).toBeInstanceOf(RunLeaseActiveError);
    expect(loss?.reason).toMatchObject({ owner: { pid: process.pid } });
    const [winner, ...rest] = await readLeaseRecords(runId);
    expect(rest).toEqual([]);
    expect(
      await StorageFS.exists(runLeasePath(runId, winner!.ownerToken)),
    ).toBe(true);
    expect(ownsRunLease(runId)).toBe(true);
  });

  it('keeps re-reading while a larger live competitor withdraws, never yielding to it', async () => {
    const runId = 'b86456' as RunId;
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
      await writeForeignLease(runId, largerToken);
      published = true;
      return originalPublish(target, content);
    });
    vi.spyOn(fs, 'readDirectory').mockImplementation(async (target) => {
      if (published && target.endsWith(runId)) {
        readsAfterPublish += 1;
        if (readsAfterPublish === 3) {
          await StorageFS.delete(runLeasePath(runId, largerToken));
        }
      }
      return originalReadDir(target);
    });

    await expect(acquireFreshRunLease(runId)).resolves.toBe('acquired');
    ownedRunIds.add(runId);
    expect(readsAfterPublish).toBe(3);
    const [record, ...rest] = await readLeaseRecords(runId);
    expect(rest).toEqual([]);
    expect(record!.ownerToken < largerToken).toBe(true);
    expect(ownsRunLease(runId)).toBe(true);
  });

  it('never removes a live claim published after a stale read of a dead one', async () => {
    const runId = 'b86454' as RunId;
    const liveToken = '00000000-0000-4000-8000-00000000000b';
    await writeOrphanedLease(runId);
    const staleRead = gateNextLeaseRead();

    const claim = acquireResumedRunLease(runId);
    await staleRead.started;
    // Between the stale read of the dead record and its removal, another
    // process claims the run. Its file has its own name, so removing
    // the dead one cannot touch it, and the late claimant backs out.
    await writeForeignLease(runId, liveToken);
    staleRead.release();

    await expect(claim).rejects.toMatchObject({
      name: 'RunLeaseActiveError',
    });
    expect(ownsRunLease(runId)).toBe(false);
    expect(await StorageFS.exists(runLeasePath(runId))).toBe(false);
    expect(await StorageFS.exists(runLeasePath(runId, liveToken))).toBe(true);
    expect(await readLeaseRecords(runId)).toHaveLength(1);
  });

  it('rejects resume while another live owner holds the lease', async () => {
    const runId = 'd8644d' as RunId;
    await writeForeignLease(runId);

    await expect(acquireResumedRunLease(runId)).rejects.toBeInstanceOf(
      RunLeaseActiveError,
    );
  });

  it('starts a resume only after the previous generation has released its lease', async () => {
    const runId = 'd8645a' as RunId;
    const registry = new RunRegistry({
      runView: () => undefined,
      publish: () => {},
      approvals: createSessionApprovals({ setApprovalBypassState() {} }),
      releaseRootRunLease: () => Effect.void,
      finalizeRun: (input) =>
        Effect.succeed({ ok: true, outcome: input.outcome }),
    });
    const readToken = async (): Promise<string> => {
      const [record, ...rest] = await readLeaseRecords(runId);
      expect(rest).toEqual([]);
      return record!.ownerToken;
    };
    const disposing = createDeferred();
    let resumeStarted = false;

    try {
      const first = Effect.runPromise(
        registry.launchRun(
          runId,
          Effect.promise(async () => {
            await acquireFreshRunLease(runId);
            await disposing.promise;
            await releaseOwnedRunLease(runId);
          }),
        ),
      );
      await vi.waitFor(() => expect(ownsRunLease(runId)).toBe(true));
      const firstToken = await readToken();

      const second = Effect.runPromise(
        registry.launchRun(
          runId,
          Effect.promise(async () => {
            resumeStarted = true;
            return acquireResumedRunLease(runId);
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
      ownedRunIds.add(runId);
      await expect(readToken()).resolves.not.toBe(firstToken);
    } finally {
      registry.dispose();
    }
  });

  it('surfaces a transient resume validation failure without dropping ownership', async () => {
    const runId = 'd86451' as RunId;
    await acquire(runId);
    vi.spyOn(platform().fs, 'stat').mockRejectedValueOnce(
      new Error('temporary filesystem failure'),
    );

    await expect(acquireResumedRunLease(runId)).rejects.toThrow(
      'temporary filesystem failure',
    );
    expect(ownsRunLease(runId)).toBe(true);
  });

  it('keeps resumed ownership live until terminal lifecycle release', async () => {
    const runId = 'd86440' as RunId;
    await writeRun(runId);
    await acquire(runId);

    await expect(inspectRunLease(runId)).resolves.toMatchObject({
      status: 'owned',
    });
    const session = createProcessSession();
    publishTestRunStart(session, runId);
    await session.settlePublications();
    await Effect.runPromise(
      finalizeRun(session, {
        runId,
        outcome: RUN_OUTCOME.COMPLETED,
      }),
    );
    await releaseOwnedRunLease(runId);
    ownedRunIds.delete(runId);

    await expect(inspectRunLease(runId)).resolves.toEqual({
      status: 'free',
    });
  });

  it('stops claiming ownership even when the lease deletion fails', async () => {
    const runId = 'd86444' as RunId;
    const deletionError = new Error('lease deletion failed');
    await acquire(runId);
    vi.spyOn(StorageFS, 'delete').mockRejectedValueOnce(deletionError);

    await expect(releaseOwnedRunLease(runId)).rejects.toBe(deletionError);
    ownedRunIds.delete(runId);

    expect(ownsRunLease(runId)).toBe(false);
    await expect(inspectRunLease(runId)).resolves.toEqual({
      status: 'held',
      owner: expect.objectContaining({ pid: process.pid }),
    });
  });

  it('releases only when the persisted owner still matches', async () => {
    const runId = 'e8644e' as RunId;
    await acquire(runId);
    await writeForeignLease(runId, '00000000-0000-4000-8000-000000000002');

    await releaseOwnedRunLease(runId);
    ownedRunIds.delete(runId);

    await expect(inspectRunLease(runId)).resolves.toMatchObject({
      status: 'held',
    });
  });

  it('fences the durability boundary immediately after takeover', async () => {
    const runId = 'e86440' as RunId;
    await acquire(runId);
    await displaceLease(runId, '00000000-0000-4000-8000-000000000004');

    await expect(validateOwnedRunLease(runId)).rejects.toBeInstanceOf(
      RunLeaseLostError,
    );

    // The first refusal also forgets the lost claim, so every later
    // boundary refuses without touching the disk again.
    expect(ownsRunLease(runId)).toBe(false);
    await expect(validateOwnedRunLease(runId)).rejects.toBeInstanceOf(
      RunLeaseLostError,
    );
    ownedRunIds.delete(runId);
  });

  it('refuses the durability boundary while another owner has a lease', async () => {
    const runId = 'e86446' as RunId;
    await writeForeignLease(runId);

    await expect(validateOwnedRunLease(runId)).rejects.toBeInstanceOf(
      RunLeaseLostError,
    );
  });

  it('rejects validation when release starts during its record read', async () => {
    const runId = 'e86443' as RunId;
    await acquire(runId);
    const read = gateNextLeaseRead('stat');

    const validation = validateOwnedRunLease(runId);
    await read.started;
    const release = releaseOwnedRunLease(runId);
    read.release();

    await expect(validation).rejects.toBeInstanceOf(RunLeaseLostError);
    await release;
    ownedRunIds.delete(runId);
  });

  it('refuses acquisition while maintenance holds the claim, then frees it', async () => {
    const runId = 'f8644f' as RunId;
    const deletionPaused = createDeferred();
    const deletionStarted = createDeferred();
    const deletion = runWithInactiveRunLease(runId, async () => {
      deletionStarted.resolve();
      await deletionPaused.promise;
      return 'removed';
    });
    await deletionStarted.promise;

    // Maintenance is itself a claim held by this live process.
    await expect(acquireResumedRunLease(runId)).rejects.toMatchObject({
      name: 'RunLeaseActiveError',
      owner: { pid: process.pid },
    });

    deletionPaused.resolve();
    await expect(deletion).resolves.toEqual({
      status: 'performed',
      value: 'removed',
    });
    await expect(inspectRunLease(runId)).resolves.toEqual({
      status: 'free',
    });
    await acquire(runId);
    await expect(inspectRunLease(runId)).resolves.toMatchObject({
      status: 'owned',
    });
  });

  it('keeps a locally owned run active whatever its record claims', async () => {
    const runId = 'f86440' as RunId;
    await acquire(runId);
    const [persisted] = await readLeaseRecords(runId);
    // Even a record naming a dead instance never lets maintenance reap the
    // live local owner: token identity short-circuits before any probe.
    await writeOrphanedLease(runId, persisted!.ownerToken);
    const operation = vi.fn(async () => 'removed');

    await expect(
      runWithInactiveRunLease(runId, operation),
    ).resolves.toMatchObject({ status: 'active' });
    expect(operation).not.toHaveBeenCalled();
  });
});
