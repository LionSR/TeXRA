// Node imports
import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';

// Local imports
import { ExecutionLeaseSchema } from '@agent/storage/executionLease';
import type { LeaseOwnerRecord } from '@agent/storage/leaseOwnerLiveness';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { StorageFS } from '@utils/files/storageFS';
import type { z } from 'zod';

/**
 * A lease owner that is never this process: local ownership always uses a
 * freshly generated UUID, so a fixed token reads back as foreign ownership.
 */
const FOREIGN_OWNER_TOKEN = '00000000-0000-4000-8000-000000000001';

/** Storage-relative directory holding an execution's claim files. */
export function executionLeaseDir(executionId: string): string {
  return `${WORKSPACE_STORAGE_LAYOUT.executionLeases}/${executionId}`;
}

/** Storage-relative path of one claim file (the foreign fixture's by default). */
export function executionLeasePath(
  executionId: string,
  ownerToken: string = FOREIGN_OWNER_TOKEN,
): string {
  return `${executionLeaseDir(executionId)}/${ownerToken}.json`;
}

/** Every claim record currently published for an execution, in token order. */
export async function readLeaseRecords(
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

export interface ForeignInstance {
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
export async function startForeignInstance(): Promise<ForeignInstance> {
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
export function deadOwner(): Promise<LeaseOwnerRecord> {
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
export async function writeForeignLease(
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
export async function displaceLease(
  executionId: string,
  ownerToken: string,
  owner?: LeaseOwnerRecord,
): Promise<void> {
  await StorageFS.delete(executionLeaseDir(executionId), { recursive: true });
  await writeForeignLease(executionId, ownerToken, owner);
}

/** Persist a lease whose owner is provably dead, so the record is reclaimable. */
export async function writeOrphanedLease(
  executionId: string,
  ownerToken: string = FOREIGN_OWNER_TOKEN,
): Promise<void> {
  await writeLeaseFixture(executionId, await deadOwner(), ownerToken);
}
