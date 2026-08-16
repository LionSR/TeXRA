// Node imports
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

// Local imports
import { ExecutionLeaseSchema } from '@agent/storage/executionLease';
import type { InstanceOwnerRecord } from '@agent/storage/instancePresence';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { StorageFS } from '@utils/files/storageFS';

/**
 * A lease owner that is never this process: local ownership always uses a
 * freshly generated UUID, so a fixed token reads back as foreign ownership.
 */
const FOREIGN_OWNER_TOKEN = '00000000-0000-4000-8000-000000000001';

/** Storage-relative path of an execution's persisted lease record. */
export function executionLeasePath(executionId: string): string {
  return `${WORKSPACE_STORAGE_LAYOUT.executionLeases}/${executionId}.json`;
}

function fixtureSocketPath(instanceId: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\texra-test-${instanceId}`;
  }
  return path.join(
    mkdtempSync(path.join(os.tmpdir(), 'texra-lease-')),
    'i.sock',
  );
}

export interface ForeignInstance {
  readonly owner: InstanceOwnerRecord;
  /** Kill the "other process": watchers observe its exit for real. */
  readonly shutdown: () => Promise<void>;
}

/**
 * A real, listening presence socket owned by "another process". Its liveness
 * is proven the production way: probes connect and read its banner.
 */
export async function startForeignInstance(): Promise<ForeignInstance> {
  const instanceId = `test-foreign-${randomUUID().slice(0, 8)}`;
  const socketPath = fixtureSocketPath(instanceId);
  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => undefined);
    socket.write(`texra-presence:${instanceId}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  server.unref();
  return {
    // The pid is a death-proof-only input consulted on ENOENT: recording an
    // already-exited pid makes shutdown() (which unlinks the socket file)
    // read as process death, while the live listener still probes alive.
    owner: {
      instanceId,
      socketPath,
      pid: provablyDeadPid(),
      hostname: os.hostname(),
    },
    shutdown: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let sharedForeignInstance: Promise<ForeignInstance> | undefined;

/**
 * One shared live listener serves every plain fixture lease in a worker; it
 * is unref'd so it never holds the process open, and worker exit is its
 * shutdown. Tests that need to *kill* the owner start their own instance.
 */
function ensureLiveForeignInstance(): Promise<InstanceOwnerRecord> {
  sharedForeignInstance ??= startForeignInstance();
  return sharedForeignInstance.then((instance) => instance.owner);
}

let exitedChildPid: number | undefined;

/**
 * A pid the kernel proves dead (ESRCH): a child spawned and already exited.
 * Needed because a missing socket file is a death proof only together with a
 * provably dead pid.
 */
function provablyDeadPid(): number {
  exitedChildPid ??= spawnSync(process.execPath, ['-e', '']).pid;
  return exitedChildPid;
}

/** An owner identity whose socket provably has no listener. */
function deadInstanceOwner(): InstanceOwnerRecord {
  const instanceId = `test-dead-${randomUUID().slice(0, 8)}`;
  return {
    instanceId,
    socketPath: fixtureSocketPath(instanceId),
    pid: provablyDeadPid(),
    hostname: os.hostname(),
  };
}

async function writeLeaseFixture(
  executionId: string,
  owner: InstanceOwnerRecord,
  ownerToken: string,
): Promise<void> {
  const lease = ExecutionLeaseSchema.parse({
    version: 2,
    executionId,
    ownerToken,
    acquiredAt: Date.now(),
    owner,
  });
  await StorageFS.ensureDir(WORKSPACE_STORAGE_LAYOUT.executionLeases);
  await StorageFS.writeAtomic(
    executionLeasePath(executionId),
    JSON.stringify(lease),
  );
}

/**
 * Persist a lease held by another live process, validated against the
 * production lease schema so a schema change breaks every fixture in one
 * place. The recorded owner answers liveness probes for real.
 */
export async function writeForeignLease(
  executionId: string,
  ownerToken: string = FOREIGN_OWNER_TOKEN,
  owner?: InstanceOwnerRecord,
): Promise<void> {
  await writeLeaseFixture(
    executionId,
    owner ?? (await ensureLiveForeignInstance()),
    ownerToken,
  );
}

/**
 * Persist a lease whose owner is provably dead: its socket path has no
 * listener, so probes return a death verdict and the record is reclaimable.
 */
export async function writeOrphanedLease(
  executionId: string,
  ownerToken: string = FOREIGN_OWNER_TOKEN,
): Promise<void> {
  await writeLeaseFixture(executionId, deadInstanceOwner(), ownerToken);
}
