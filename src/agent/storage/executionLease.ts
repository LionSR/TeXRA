import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { lock } from 'proper-lockfile';
import { z } from 'zod';

import { platform } from '@platform/platform';
import { isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'ExecutionLease';
const LEASE_FILE_NAME = 'lease.json';
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = {
  retries: 8,
  factor: 1.5,
  minTimeout: 25,
  maxTimeout: 250,
  randomize: true,
} as const;

/** A host that misses four heartbeats is no longer considered live. */
export const EXECUTION_LEASE_STALE_MS = 60_000;
const EXECUTION_LEASE_HEARTBEAT_MS = 15_000;

const LeaseExecutionIdSchema = z
  .string()
  .min(1)
  .regex(/^[^/\\]+$/);

const ExecutionLeaseSchema = z
  .strictObject({
    version: z.literal(1),
    executionId: LeaseExecutionIdSchema,
    ownerToken: z.uuid(),
    acquiredAt: z.int().nonnegative(),
    heartbeatAt: z.int().nonnegative(),
  })
  .refine((lease) => lease.heartbeatAt >= lease.acquiredAt, {
    message: 'Execution lease heartbeat precedes acquisition.',
    path: ['heartbeatAt'],
  });

type ExecutionLeaseRecord = z.infer<typeof ExecutionLeaseSchema>;

interface OwnedExecutionLease {
  readonly executionId: ExecutionId;
  readonly ownerToken: string;
  readonly storageRoot: string;
  readonly timer: ReturnType<typeof setInterval>;
}

export type ExecutionLeasePresence =
  | { readonly status: 'missing' }
  | { readonly status: 'stale'; readonly heartbeatAt: number }
  | { readonly status: 'owned'; readonly heartbeatAt: number }
  | { readonly status: 'foreign'; readonly heartbeatAt: number };

export class ExecutionLeaseActiveError extends Error {
  constructor(
    readonly executionId: ExecutionId,
    readonly heartbeatAt: number,
  ) {
    super(`Execution ${executionId} is active in another TeXRA host.`);
    this.name = 'ExecutionLeaseActiveError';
  }
}

const ownedLeases = new Map<string, OwnedExecutionLease>();

function storageRoot(): string {
  return platform().storage.getStoragePath();
}

function ownershipKey(root: string, executionId: ExecutionId): string {
  return `${root}\0${executionId}`;
}

function leaseDirectory(executionId: ExecutionId): string {
  const safeExecutionId = LeaseExecutionIdSchema.parse(executionId);
  return `${WORKSPACE_STORAGE_LAYOUT.executionLeases}/${safeExecutionId}`;
}

function leasePath(root: string, executionId: ExecutionId): string {
  return path.join(root, leaseDirectory(executionId), LEASE_FILE_NAME);
}

function coordinationDirectory(root: string, executionId: ExecutionId): string {
  const storageKey = createHash('sha256')
    .update(root)
    .digest('hex')
    .slice(0, 24);
  return path.join(
    tmpdir(),
    'texra-execution-lease-locks',
    storageKey,
    executionId,
  );
}

async function readLease(
  executionId: ExecutionId,
  root: string,
): Promise<ExecutionLeaseRecord | undefined> {
  try {
    const record = await StorageFS.readJson(
      leasePath(root, executionId),
      ExecutionLeaseSchema,
    );
    if (record.executionId !== executionId) {
      throw new Error(
        `Execution lease identity mismatch: expected ${executionId}, found ${record.executionId}.`,
      );
    }
    return record;
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
}

async function writeLease(
  record: ExecutionLeaseRecord,
  root: string,
): Promise<void> {
  const persisted = ExecutionLeaseSchema.parse(record);
  await StorageFS.writeAtomic(
    leasePath(root, record.executionId),
    `${JSON.stringify(persisted, null, 2)}\n`,
  );
}

async function withLeaseLock<T>(
  executionId: ExecutionId,
  operation: () => Promise<T>,
  root: string = storageRoot(),
): Promise<T> {
  const relativeDirectory = leaseDirectory(executionId);
  await StorageFS.ensureDir(path.join(root, relativeDirectory));
  const absoluteDirectory = coordinationDirectory(root, executionId);
  await mkdir(absoluteDirectory, { recursive: true });
  const release = await lock(absoluteDirectory, {
    realpath: false,
    stale: LOCK_STALE_MS,
    retries: LOCK_RETRIES,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

function isFresh(record: ExecutionLeaseRecord, now: number): boolean {
  return now - record.heartbeatAt <= EXECUTION_LEASE_STALE_MS;
}

function forgetOwnedLease(lease: OwnedExecutionLease): void {
  clearInterval(lease.timer);
  const key = ownershipKey(lease.storageRoot, lease.executionId);
  if (ownedLeases.get(key) === lease) ownedLeases.delete(key);
}

async function heartbeat(lease: OwnedExecutionLease): Promise<void> {
  await withLeaseLock(
    lease.executionId,
    async () => {
      const current = await readLease(lease.executionId, lease.storageRoot);
      if (current?.ownerToken !== lease.ownerToken) {
        forgetOwnedLease(lease);
        return;
      }
      await writeLease(
        { ...current, heartbeatAt: Date.now() },
        lease.storageRoot,
      );
    },
    lease.storageRoot,
  );
}

function rememberOwnership(
  executionId: ExecutionId,
  ownerToken: string,
  root: string,
): void {
  const timer = setInterval(() => {
    void heartbeat(lease).catch((error: unknown) => {
      logger.warn(
        CHANNEL,
        `Failed to heartbeat execution ${executionId}: ${toErrorMessage(error)}`,
        { data: error },
      );
    });
  }, EXECUTION_LEASE_HEARTBEAT_MS);
  timer.unref();
  const lease: OwnedExecutionLease = {
    executionId,
    ownerToken,
    storageRoot: root,
    timer,
  };
  ownedLeases.set(ownershipKey(root, executionId), lease);
}

async function acquireExecutionLease(
  executionId: ExecutionId,
  mode: 'fresh' | 'resume',
): Promise<'acquired' | 'existing'> {
  const root = storageRoot();
  const key = ownershipKey(root, executionId);
  const existingOwnership = ownedLeases.get(key);
  if (mode === 'resume' && existingOwnership) {
    await heartbeat(existingOwnership);
    if (ownedLeases.get(key) === existingOwnership) return 'existing';
  }

  return withLeaseLock(
    executionId,
    async () => {
      const now = Date.now();
      const current = await readLease(executionId, root);
      if (current && isFresh(current, now)) {
        throw new ExecutionLeaseActiveError(executionId, current.heartbeatAt);
      }
      const ownerToken = randomUUID();
      if (existingOwnership) forgetOwnedLease(existingOwnership);
      await writeLease(
        {
          version: 1,
          executionId,
          ownerToken,
          acquiredAt: now,
          heartbeatAt: now,
        },
        root,
      );
      rememberOwnership(executionId, ownerToken, root);
      return 'acquired' as const;
    },
    root,
  );
}

/** Acquire a new execution before any execution-scoped data becomes writable. */
export function acquireFreshExecutionLease(
  executionId: ExecutionId,
): Promise<'acquired' | 'existing'> {
  return acquireExecutionLease(executionId, 'fresh');
}

/** Establish ownership before a persisted execution is resumed. */
export function acquireResumedExecutionLease(
  executionId: ExecutionId,
): Promise<'acquired' | 'existing'> {
  return acquireExecutionLease(executionId, 'resume');
}

/** Release this process's lease, but never remove a later owner's record. */
export async function releaseOwnedExecutionLease(
  executionId: ExecutionId,
): Promise<void> {
  const root = storageRoot();
  const key = ownershipKey(root, executionId);
  const ownership = ownedLeases.get(key);
  if (!ownership) return;

  try {
    await withLeaseLock(
      executionId,
      async () => {
        const current = await readLease(executionId, root);
        if (current?.ownerToken !== ownership.ownerToken) return;
        await StorageFS.delete(leasePath(root, executionId));
      },
      root,
    );
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  } finally {
    forgetOwnedLease(ownership);
  }
}

/** Classify persisted liveness. Malformed present state rejects deliberately. */
export async function inspectExecutionLease(
  executionId: ExecutionId,
  now: number = Date.now(),
): Promise<ExecutionLeasePresence> {
  const root = storageRoot();
  const current = await readLease(executionId, root);
  if (!current) return { status: 'missing' };
  if (!isFresh(current, now)) {
    return { status: 'stale', heartbeatAt: current.heartbeatAt };
  }
  const local = ownedLeases.get(ownershipKey(root, executionId));
  return {
    status: local?.ownerToken === current.ownerToken ? 'owned' : 'foreign',
    heartbeatAt: current.heartbeatAt,
  };
}

/**
 * Serialize a destructive operation with lease acquisition. Fresh leases are
 * authoritative; stale records are removed only after the operation succeeds.
 */
export async function runWithExecutionDeletionGuard<T>(
  executionId: ExecutionId,
  operation: () => Promise<T>,
): Promise<
  | { readonly status: 'active'; readonly heartbeatAt: number }
  | { readonly status: 'performed'; readonly value: T }
> {
  const root = storageRoot();
  return withLeaseLock(
    executionId,
    async () => {
      const current = await readLease(executionId, root);
      if (current && isFresh(current, Date.now())) {
        return { status: 'active', heartbeatAt: current.heartbeatAt };
      }
      const value = await operation();
      if (current) await StorageFS.delete(leasePath(root, executionId));
      return { status: 'performed', value };
    },
    root,
  );
}
